import { lstat, mkdir, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { validateSessionId, type ManagedWorkspaceBinding, type SessionSummary } from '@whycode/core'
import { WorkspaceOwnershipError } from './workspace-ownership-error.ts'
import { WorkspaceMutations, removeEmptyWorkspace, retainWorkspace, workspaceName, type WorkspaceReleaseOptions } from './workspace-retention.ts'
import { ManagedWorkspaceStore, bindingFromManifest, assertSameBinding, type ManagedWorkspaceManifest } from './managed-workspace-store.ts'
import { directoriesOverlap } from './workspace-path.ts'

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
  private readonly store: ManagedWorkspaceStore
  private readonly mutations = new WorkspaceMutations()

  constructor(rootDirectory: string, manifestDirectory: string) {
    this.rootDirectory = resolve(rootDirectory)
    this.store = new ManagedWorkspaceStore(this.rootDirectory, resolve(manifestDirectory))
  }

  plannedDirectory(id: string): string {
    return this.store.plannedDirectory(id)
  }

  create(id: string): Promise<ManagedWorkspaceBinding> {
    return this.store.create(id)
  }

  async restoreDraft(id: string): Promise<ManagedWorkspaceBinding | null> {
    let manifest: ManagedWorkspaceManifest
    try { manifest = await this.store.read(id) } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
    if (manifest.sessionIds.length || manifest.retention) throw new Error('默认工作区已经属于已发送的会话或保留工作区')
    const info = await lstat(manifest.workingDirectory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('新会话工作区不是普通目录')
    return bindingFromManifest(manifest)
  }

  attachSession(binding: ManagedWorkspaceBinding, sessionId: string): Promise<void> {
    return this.mutations.run(binding.id, async () => {
      validateSessionId(sessionId)
      const manifest = await this.store.read(binding.id)
      assertSameBinding(manifest, binding)
      if (manifest.sessionIds.includes(sessionId)) return
      await this.store.write({ ...manifest, retention: null, sessionIds: [...manifest.sessionIds, sessionId] })
    })
  }

  async assertUsable(binding: ManagedWorkspaceBinding, sessionId: string): Promise<void> {
    validateSessionId(sessionId)
    const manifest = await this.store.read(binding.id)
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
  remove(binding: ManagedWorkspaceBinding, protectDirectory = false): Promise<void> {
    return this.mutations.run(binding.id, async () => {
      const manifest = await this.store.read(binding.id)
      assertSameBinding(manifest, binding)
      if (manifest.sessionIds.length) throw new Error('默认工作区仍被会话引用')
      if (manifest.retention) throw new Error('保留的默认工作区不能作为草稿清理')
      await this.releaseDirectory(manifest, { deleteDirectory: false, name: '未发送会话', protectDirectory })
    })
  }

  detachSession(
    binding: ManagedWorkspaceBinding,
    sessionId: string,
    options: WorkspaceReleaseOptions = { deleteDirectory: false, name: '默认工作区', protectDirectory: false },
  ): Promise<void> {
    return this.mutations.run(binding.id, async () => {
      let manifest: ManagedWorkspaceManifest
      try { manifest = await this.store.read(binding.id) } catch (error) {
        if (isNotFound(error)) {
          const directory = await lstat(binding.workingDirectory).catch((error) => {
            if (isNotFound(error)) return null
            throw error
          })
          if (directory) throw new WorkspaceOwnershipError('默认工作区所有权记录缺失')
          return
        }
        throw error
      }
      assertSameBinding(manifest, binding)
      await this.releaseSession(manifest, sessionId, options)
    })
  }

  /** 按持久会话补齐引用，覆盖 Fork 落盘后、认领前的崩溃窗口。 */
  async cleanupAbandoned(
    sessions: readonly Pick<SessionSummary, 'sessionId' | 'workspace'>[],
    draftIds: ReadonlySet<string>,
    protectedDirectories: readonly string[] = [],
  ): Promise<ManagedWorkspaceCleanupResult> {
    const result: ManagedWorkspaceCleanupResult = { removed: [], warnings: [] }
    const byWorkspace = new Map<string, { sessionId: string; workspace: ManagedWorkspaceBinding }[]>()
    for (const item of sessions) {
      if (item.workspace?.mode !== 'managed') continue
      const references = byWorkspace.get(item.workspace.id) ?? []
      references.push({ sessionId: item.sessionId, workspace: item.workspace })
      byWorkspace.set(item.workspace.id, references)
    }
    for (const candidate of await this.store.readAll(result.warnings)) {
      try {
        await this.mutations.run(candidate.id, async () => {
          const manifest = await this.store.read(candidate.id)
          const references = byWorkspace.get(manifest.id) ?? []
          for (const reference of references) {
            validateSessionId(reference.sessionId)
            assertSameBinding(manifest, reference.workspace)
          }
          // 仅显式解除归属才释放引用，历史缺失不能证明项目目录可回收。
          const sessionIds = [...new Set([
            ...references.map(item => item.sessionId),
            ...manifest.sessionIds,
          ])]
          if (!sessionIds.length && !manifest.retention && !draftIds.has(manifest.id)) {
            if (await this.releaseDirectory(manifest, {
              deleteDirectory: false, name: '未发送会话',
              protectDirectory: protectedDirectories.some(path => directoriesOverlap(path, manifest.workingDirectory)),
            })) result.removed.push(manifest.id)
          } else if (sessionIds.length !== manifest.sessionIds.length
            || sessionIds.some(id => !manifest.sessionIds.includes(id))) {
            await this.store.write({ ...manifest, retention: sessionIds.length ? null : manifest.retention, sessionIds })
          }
        })
      } catch (error) {
        result.warnings.push(errorMessage(error))
      }
    }
    return result
  }

  async inspect(binding: ManagedWorkspaceBinding): Promise<ManagedWorkspaceManifest> {
    const manifest = await this.store.read(binding.id)
    assertSameBinding(manifest, binding)
    return manifest
  }

  async records(): Promise<{ records: ManagedWorkspaceManifest[]; warnings: string[] }> {
    const warnings: string[] = []
    return { records: await this.store.readAll(warnings), warnings }
  }

  renameRetained(id: string, name: string): Promise<void> {
    return this.mutations.run(id, async () => {
      const manifest = await this.store.read(id)
      if (!manifest.retention || manifest.sessionIds.length) throw new Error('工作区已不在保留列表中')
      await this.store.write({ ...manifest, retention: { ...manifest.retention, name: workspaceName(name) } })
    })
  }

  deleteRetained(id: string): Promise<void> {
    return this.mutations.run(id, async () => {
      const manifest = await this.store.read(id)
      if (!manifest.retention || manifest.sessionIds.length) throw new Error('工作区已不在保留列表中')
      await this.store.removeDirectory(manifest)
    })
  }

  private async releaseSession(
    manifest: ManagedWorkspaceManifest, sessionId: string, options: WorkspaceReleaseOptions,
  ): Promise<void> {
    validateSessionId(sessionId)
    if (!manifest.sessionIds.includes(sessionId) && !manifest.retention) return
    const sessionIds = manifest.sessionIds.filter(id => id !== sessionId)
    if (sessionIds.length) await this.store.write({ ...manifest, sessionIds })
    else await this.releaseDirectory({ ...manifest, sessionIds }, options)
  }

  private async releaseDirectory(manifest: ManagedWorkspaceManifest, options: WorkspaceReleaseOptions): Promise<boolean> {
    if (!options.protectDirectory) {
      if (options.deleteDirectory) {
        await this.store.removeDirectory(manifest)
        return true
      }
      if (await removeEmptyWorkspace(manifest.workingDirectory)) {
        await this.store.removeManifest(manifest.id)
        return true
      }
    }
    await this.store.write({ ...manifest, retention: retainWorkspace(options.name, manifest.retention) })
    return false
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
