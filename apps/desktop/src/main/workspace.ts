import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ManagedWorkspaceBinding, SessionSummary } from '@whycode/core'

export const DEFAULT_WORKSPACE_NAME = 'WhyCode Workspace'

/**
 * 首次启动即提供一个真实、可写的工作目录；Documents 不可用时退回应用私有目录。
 * 返回规范化绝对路径，确保工具、命令 cwd 与界面展示引用同一事实。
 */
export async function ensureDefaultWorkspace(
  documentsDirectory: string,
  userDataDirectory: string,
): Promise<string> {
  const preferred = join(resolve(documentsDirectory), DEFAULT_WORKSPACE_NAME)
  try {
    return await ensureDirectory(preferred)
  } catch (preferredError) {
    const fallback = join(resolve(userDataDirectory), 'workspace')
    try {
      return await ensureDirectory(fallback)
    } catch (fallbackError) {
      throw new AggregateError(
        [preferredError, fallbackError],
        '无法创建 WhyCode 默认工作文件夹',
      )
    }
  }
}

async function ensureDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await stat(path)
  if (!info.isDirectory()) throw new Error(`默认工作路径不是文件夹：${path}`)
  return realpath(path)
}

interface ManagedWorkspaceManifest {
  schemaVersion: 2
  id: string
  workingDirectory: string
  createdAt: string
  sessionIds: string[]
}

export interface ManagedWorkspaceCleanupResult {
  removed: string[]
  warnings: string[]
}

/**
 * 默认工作区的共享所有权事实。独立新会话创建目录，Fork 添加引用，外置 manifest
 * 不会暴露给模型，也让 delete-only 重试能在会话元数据不可读时继续完成清理。
 */
export class ManagedWorkspaceManager {
  readonly rootDirectory: string
  private readonly manifestDirectory: string
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(rootDirectory: string, manifestDirectory: string) {
    this.rootDirectory = resolve(rootDirectory)
    this.manifestDirectory = resolve(manifestDirectory)
  }

  plannedDirectory(id: string): string {
    assertUuid(id)
    return join(this.rootDirectory, id)
  }

  async create(id: string): Promise<ManagedWorkspaceBinding> {
    const workingDirectory = this.plannedDirectory(id)
    const manifest: ManagedWorkspaceManifest = {
      schemaVersion: 2,
      id,
      workingDirectory,
      createdAt: new Date().toISOString(),
      sessionIds: [],
    }
    await mkdir(this.manifestDirectory, { recursive: true, mode: 0o700 })
    await writeFile(this.manifestPath(id), JSON.stringify(manifest), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
      flush: true,
    })
    try {
      await mkdir(workingDirectory, { recursive: false, mode: 0o700 })
      const canonical = await realpath(workingDirectory)
      if (!samePath(canonical, workingDirectory)) {
        throw new Error(`默认工作区规范路径不一致：${canonical}`)
      }
      return bindingFromManifest(manifest)
    } catch (error) {
      await rm(this.manifestPath(id), { force: true }).catch(() => undefined)
      throw error
    }
  }

  async restoreDraft(id: string): Promise<ManagedWorkspaceBinding | null> {
    let manifest: ManagedWorkspaceManifest
    try { manifest = await this.readOwnedManifest(id) } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
    if (manifest.sessionIds.length) throw new Error('默认工作区已经属于已发送的会话')
    const info = await lstat(manifest.workingDirectory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('新会话工作区不是普通目录')
    return bindingFromManifest(manifest)
  }

  attachSession(binding: ManagedWorkspaceBinding, sessionId: string): Promise<void> {
    return this.mutate(async () => {
      assertUuid(sessionId)
      const manifest = await this.readOwnedManifest(binding.id)
      assertSameBinding(manifest, binding)
      if (manifest.sessionIds.includes(sessionId)) return
      await this.replaceManifest({ ...manifest, sessionIds: [...manifest.sessionIds, sessionId] })
    })
  }

  async assertUsable(binding: ManagedWorkspaceBinding, sessionId: string): Promise<void> {
    assertUuid(sessionId)
    const manifest = await this.readOwnedManifest(binding.id)
    assertSameBinding(manifest, binding)
    if (!manifest.sessionIds.includes(sessionId)) {
      throw new Error('默认工作区与会话绑定不一致')
    }
    const info = await lstat(binding.workingDirectory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`默认工作区不是普通目录：${binding.workingDirectory}`)
    }
  }

  /** 仅未发送的新会话草稿可以直接清理，已有会话必须释放自身引用。 */
  remove(binding: ManagedWorkspaceBinding): Promise<void> {
    return this.mutate(async () => {
      const manifest = await this.readOwnedManifest(binding.id)
      assertSameBinding(manifest, binding)
      if (manifest.sessionIds.length) throw new Error('默认工作区仍被会话引用')
      await this.removeManifestWorkspace(manifest)
    })
  }

  detachSession(binding: ManagedWorkspaceBinding, sessionId: string): Promise<void> {
    return this.mutate(async () => {
      let manifest: ManagedWorkspaceManifest
      try { manifest = await this.readOwnedManifest(binding.id) } catch (error) {
        if (isNotFound(error)) return
        throw error
      }
      assertSameBinding(manifest, binding)
      await this.releaseSession(manifest, sessionId)
    })
  }

  removeSession(sessionId: string): Promise<void> {
    return this.mutate(async () => {
      const warnings: string[] = []
      for (const manifest of await this.readAllManifests(warnings)) {
        if (manifest.sessionIds.includes(sessionId)) {
          await this.releaseSession(manifest, sessionId)
          return
        }
      }
      if (warnings.length > 0) {
        throw new Error(`默认工作区所有权记录损坏，未完成删除：${warnings.join('；')}`)
      }
    })
  }

  /** 按持久会话重建引用，覆盖 Fork 落盘后、认领前的崩溃窗口。 */
  cleanupAbandoned(
    sessions: readonly Pick<SessionSummary, 'sessionId' | 'workspace'>[],
    draftIds: ReadonlySet<string>,
  ): Promise<ManagedWorkspaceCleanupResult> {
    return this.mutate(async () => {
      const result: ManagedWorkspaceCleanupResult = { removed: [], warnings: [] }
      const unknown = new Set(sessions.filter(item => !item.workspace).map(item => item.sessionId))
      const byWorkspace = new Map<string, { sessionId: string; workspace: ManagedWorkspaceBinding }[]>()
      for (const item of sessions) {
        if (item.workspace?.mode !== 'managed') continue
        const references = byWorkspace.get(item.workspace.id) ?? []
        references.push({ sessionId: item.sessionId, workspace: item.workspace })
        byWorkspace.set(item.workspace.id, references)
      }
      for (const manifest of await this.readAllManifests(result.warnings)) {
        try {
          const references = byWorkspace.get(manifest.id) ?? []
          for (const reference of references) {
            assertUuid(reference.sessionId)
            assertSameBinding(manifest, reference.workspace)
          }
          // 不可读的会话仍保留已有所有权，直到用户显式删除该会话。
          const sessionIds = [...new Set([
            ...references.map(item => item.sessionId),
            ...manifest.sessionIds.filter(id => unknown.has(id)),
          ])]
          if (!sessionIds.length && !draftIds.has(manifest.id)) {
            await this.removeManifestWorkspace(manifest)
            result.removed.push(manifest.id)
          } else if (sessionIds.length !== manifest.sessionIds.length
            || sessionIds.some(id => !manifest.sessionIds.includes(id))) {
            await this.replaceManifest({ ...manifest, sessionIds })
          }
        } catch (error) {
          result.warnings.push(errorMessage(error))
        }
      }
      return result
    })
  }

  private async releaseSession(manifest: ManagedWorkspaceManifest, sessionId: string): Promise<void> {
    assertUuid(sessionId)
    if (!manifest.sessionIds.includes(sessionId)) return
    const sessionIds = manifest.sessionIds.filter(id => id !== sessionId)
    if (sessionIds.length) await this.replaceManifest({ ...manifest, sessionIds })
    else await this.removeManifestWorkspace(manifest)
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation)
    this.mutationQueue = next.then(() => undefined, () => undefined)
    return next
  }

  private async removeManifestWorkspace(manifest: ManagedWorkspaceManifest): Promise<void> {
    const expected = this.plannedDirectory(manifest.id)
    if (!samePath(manifest.workingDirectory, expected)) {
      throw new Error(`默认工作区 manifest 路径越界：${manifest.workingDirectory}`)
    }
    try {
      const info = await lstat(expected)
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`默认工作区不是普通目录：${expected}`)
      }
      await rm(expected, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 })
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
    await rm(this.manifestPath(manifest.id), { force: true })
  }

  private async readOwnedManifest(id: string): Promise<ManagedWorkspaceManifest> {
    const manifest = parseManifest(await readFile(this.manifestPath(id), 'utf8'))
    if (manifest.id !== id) throw new Error('默认工作区 manifest 身份不一致')
    return manifest
  }

  private async readAllManifests(warnings: string[] = []): Promise<ManagedWorkspaceManifest[]> {
    let names: string[]
    try {
      names = await readdir(this.manifestDirectory)
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    const manifests: ManagedWorkspaceManifest[] = []
    for (const name of names.filter((value) => value.endsWith('.json'))) {
      try {
        const manifest = parseManifest(await readFile(join(this.manifestDirectory, name), 'utf8'))
        if (name !== `${manifest.id}.json`) throw new Error('文件名与工作区 ID 不一致')
        manifests.push(manifest)
      } catch (error) {
        warnings.push(`${name}：${errorMessage(error)}`)
      }
    }
    return manifests
  }

  private async replaceManifest(manifest: ManagedWorkspaceManifest): Promise<void> {
    const target = this.manifestPath(manifest.id)
    const temporary = `${target}.${crypto.randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(manifest), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
      flush: true,
    })
    try {
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private manifestPath(id: string): string {
    assertUuid(id)
    return join(this.manifestDirectory, `${id}.json`)
  }
}

function bindingFromManifest(manifest: ManagedWorkspaceManifest): ManagedWorkspaceBinding {
  return {
    mode: 'managed',
    id: manifest.id,
    workingDirectory: manifest.workingDirectory,
    createdAt: manifest.createdAt,
  }
}

function assertSameBinding(
  manifest: ManagedWorkspaceManifest,
  binding: ManagedWorkspaceBinding,
): void {
  if (
    manifest.id !== binding.id
    || manifest.createdAt !== binding.createdAt
    || !samePath(manifest.workingDirectory, binding.workingDirectory)
  ) throw new Error('默认工作区绑定与 manifest 不一致')
}

function parseManifest(text: string): ManagedWorkspaceManifest {
  const value: unknown = JSON.parse(text)
  if (
    !value
    || typeof value !== 'object'
    || (value as ManagedWorkspaceManifest).schemaVersion !== 2
    || typeof (value as ManagedWorkspaceManifest).id !== 'string'
    || typeof (value as ManagedWorkspaceManifest).workingDirectory !== 'string'
    || typeof (value as ManagedWorkspaceManifest).createdAt !== 'string'
    || !Array.isArray((value as ManagedWorkspaceManifest).sessionIds)
  ) throw new Error('默认工作区 manifest 无效')
  const manifest = value as ManagedWorkspaceManifest
  assertUuid(manifest.id)
  for (const sessionId of manifest.sessionIds) assertUuid(sessionId)
  return manifest
}

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`默认工作区 ID 无效：${value}`)
  }
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
