import { createHash, randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  validateSessionId,
  workspaceWorkingDirectory,
  worktreeWorkspaceBindingSchema,
  type WorktreeWorkspaceBinding,
} from '@whycode/core'

interface WorktreeManifest {
  schemaVersion: 2
  binding: WorktreeWorkspaceBinding
  sessionIds: string[]
}

export interface UnclaimedWorktreeScan {
  bindings: WorktreeWorkspaceBinding[]
  warnings: string[]
}

export class ManagedWorktreeRegistry {
  private readonly configuredRoot: string
  private preparedRoot: Promise<string> | null = null

  constructor(rootDirectory: string) {
    this.configuredRoot = resolve(rootDirectory)
  }

  async expectedDirectory(repositoryDirectory: string, id: string): Promise<string> {
    const validatedId = worktreeWorkspaceBindingSchema.shape.id.parse(id)
    const fingerprint = createHash('sha256')
      .update(pathKey(repositoryDirectory))
      .digest('hex')
      .slice(0, 16)
    return resolve(await this.rootDirectory(), fingerprint, validatedId)
  }

  async validateBinding(binding: WorktreeWorkspaceBinding): Promise<void> {
    const expected = await this.expectedDirectory(binding.repositoryDirectory, binding.id)
    if (!samePath(expected, binding.worktreeDirectory)) {
      throw new Error('Worktree 路径不属于 WhyCode 受管目录')
    }
  }

  async create(binding: WorktreeWorkspaceBinding): Promise<void> {
    await this.validateBinding(binding)
    await this.write({ schemaVersion: 2, binding, sessionIds: [] })
  }

  async attachSession(
    binding: WorktreeWorkspaceBinding,
    sessionId: string,
  ): Promise<void> {
    validateSessionId(sessionId)
    const manifest = await this.read(binding)
    if (manifest.sessionIds.includes(sessionId)) return
    await this.write({ ...manifest, sessionIds: [...manifest.sessionIds, sessionId] })
  }

  /**
   * 仅修复创建 session-start 与首次认领清单之间的窄崩溃窗口。
   * 共享引用只能由显式 Fork 添加，恢复任意会话不得借此加入。
   */
  async claimSessionForResume(
    binding: WorktreeWorkspaceBinding,
    sessionId: string,
  ): Promise<void> {
    validateSessionId(sessionId)
    const manifest = await this.read(binding)
    if (manifest.sessionIds.includes(sessionId)) return
    if (manifest.sessionIds.length > 0) {
      throw new Error('Worktree 已属于其它会话')
    }
    await this.write({ ...manifest, sessionIds: [sessionId] })
  }

  async assertOwned(binding: WorktreeWorkspaceBinding): Promise<void> {
    await this.read(binding)
  }

  async assertManagedDirectory(binding: WorktreeWorkspaceBinding): Promise<void> {
    await this.validateBinding(binding)
    if (!await this.existingManagedDirectory(binding.worktreeDirectory)) {
      throw new Error('受管 Worktree 目录不存在')
    }
  }

  async sessionIds(binding: WorktreeWorkspaceBinding): Promise<string[]> {
    return [...(await this.read(binding)).sessionIds]
  }

  async detachSession(
    binding: WorktreeWorkspaceBinding,
    sessionId: string,
  ): Promise<number> {
    validateSessionId(sessionId)
    const manifest = await this.read(binding)
    const remaining = manifest.sessionIds.filter((value) => value !== sessionId)
    if (remaining.length !== manifest.sessionIds.length) {
      await this.write({ ...manifest, sessionIds: remaining })
    }
    return remaining.length
  }

  async unclaimedBindings(): Promise<UnclaimedWorktreeScan> {
    const registryRoot = resolve(await this.rootDirectory(), '.registry')
    const entries = await readdir(registryRoot, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      },
    )
    const bindings: WorktreeWorkspaceBinding[] = []
    const warnings: string[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const manifestPath = resolve(registryRoot, entry.name)
      try {
        const manifest = parseManifest(JSON.parse(
          await readFile(manifestPath, 'utf8'),
        ))
        if (!manifest || `${manifest.binding.id}.json` !== entry.name) {
          throw new Error('所有权记录无效或文件名不匹配')
        }
        await this.validateBinding(manifest.binding)
        if (manifest.sessionIds.length === 0) bindings.push(manifest.binding)
      } catch (error) {
        warnings.push(`${entry.name}: ${errorMessage(error)}`)
      }
    }
    return { bindings, warnings }
  }

  async removeManifest(binding: WorktreeWorkspaceBinding): Promise<void> {
    await this.validateBinding(binding)
    await rm(await this.manifestPath(binding.id), { force: true })
  }

  async removeDirectory(binding: WorktreeWorkspaceBinding): Promise<void> {
    await this.validateBinding(binding)
    await this.removeValidatedDirectory(binding.worktreeDirectory)
    await this.pruneEmptyRepositoryDirectory(binding)
  }

  async removeExpectedDirectory(
    repositoryDirectory: string,
    id: string,
    targetDirectory: string,
  ): Promise<void> {
    if (!samePath(
      await this.expectedDirectory(repositoryDirectory, id),
      targetDirectory,
    )) {
      throw new Error('拒绝删除受管 Worktree 根之外的目录')
    }
    await this.removeValidatedDirectory(targetDirectory)
    await this.pruneEmptyDirectory(dirname(targetDirectory))
  }

  async pruneEmptyRepositoryDirectory(
    binding: WorktreeWorkspaceBinding,
  ): Promise<void> {
    await this.validateBinding(binding)
    await this.pruneEmptyDirectory(dirname(binding.worktreeDirectory))
  }

  async pruneEmptyRepositoryDirectories(): Promise<string[]> {
    const root = await this.rootDirectory()
    const entries = await readdir(root, { withFileTypes: true })
    const removed: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f]{16}$/u.test(entry.name)) continue
      if (await this.pruneEmptyDirectory(resolve(root, entry.name))) {
        removed.push(entry.name)
      }
    }
    return removed
  }

  private async read(binding: WorktreeWorkspaceBinding): Promise<WorktreeManifest> {
    await this.validateBinding(binding)
    const text = await readFile(await this.manifestPath(binding.id), 'utf8')
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new Error('Worktree 所有权记录已损坏')
    }
    const manifest = parseManifest(value)
    if (!manifest || !isDeepStrictEqual(manifest.binding, binding)) {
      throw new Error('Worktree 所有权记录缺失或与会话不一致')
    }
    return manifest
  }

  private async write(manifest: WorktreeManifest): Promise<void> {
    const parsed = parseManifest(manifest)
    if (!parsed) throw new Error('Worktree 所有权记录无效')
    const registryRoot = resolve(await this.rootDirectory(), '.registry')
    await mkdir(registryRoot, { recursive: true, mode: 0o700 })
    const target = resolve(registryRoot, `${parsed.binding.id}.json`)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        flush: true,
        mode: 0o600,
      })
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }

  private async manifestPath(id: string): Promise<string> {
    const validatedId = worktreeWorkspaceBindingSchema.shape.id.parse(id)
    return resolve(await this.rootDirectory(), '.registry', `${validatedId}.json`)
  }

  private async removeValidatedDirectory(targetDirectory: string): Promise<void> {
    const target = await this.existingManagedDirectory(targetDirectory)
    if (!target) return
    await rm(target, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  }

  private async pruneEmptyDirectory(targetDirectory: string): Promise<boolean> {
    const target = await this.existingManagedDirectory(targetDirectory)
    if (!target) return false
    try {
      await rmdir(target)
      return true
    } catch (error) {
      if (isNotFound(error) || isDirectoryNotEmpty(error)) return false
      throw error
    }
  }

  private async existingManagedDirectory(targetDirectory: string): Promise<string | null> {
    const root = await this.rootDirectory()
    const target = resolve(targetDirectory)
    assertDescendant(root, target)
    const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) return null
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('受管 Worktree 路径不是普通目录')
    }
    const canonical = await realpath(target)
    assertDescendant(root, canonical)
    if (!samePath(canonical, target)) {
      throw new Error('受管 Worktree 路径穿过符号链接或目录联接')
    }
    return canonical
  }

  private rootDirectory(): Promise<string> {
    this.preparedRoot ??= prepareRoot(this.configuredRoot)
    return this.preparedRoot
  }
}

export async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(resolve(path))
  if (!(await stat(canonical)).isDirectory()) throw new Error(`路径不是文件夹：${path}`)
  return canonical
}

export async function assertWorktreeExecutionDirectory(
  binding: WorktreeWorkspaceBinding,
): Promise<void> {
  const executionDirectory = workspaceWorkingDirectory(binding)!
  let canonical: string
  try {
    canonical = await canonicalDirectory(executionDirectory)
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error('所选子目录不存在于 Worktree 基线或附加文件中')
    }
    throw error
  }
  const relativePath = relative(binding.worktreeDirectory, canonical)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error('Worktree 执行目录越过受管工作树')
  }
}

export async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
}

export function pathKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right)
}

function parseManifest(value: unknown): WorktreeManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const binding = worktreeWorkspaceBindingSchema.safeParse(record.binding)
  if (record.schemaVersion !== 2 || !binding.success || !Array.isArray(record.sessionIds)) return null
  if (!record.sessionIds.every((sessionId) => typeof sessionId === 'string')) return null
  for (const sessionId of record.sessionIds as string[]) {
    try {
      validateSessionId(sessionId)
    } catch {
      return null
    }
  }
  const sessionIds = record.sessionIds as string[]
  if (new Set(sessionIds).size !== sessionIds.length) return null
  return { schemaVersion: 2, binding: binding.data, sessionIds }
}

async function prepareRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  return realpath(root)
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'ENOENT',
  )
}

function isDirectoryNotEmpty(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error.code === 'ENOTEMPTY' || error.code === 'EEXIST'),
  )
}

function assertDescendant(root: string, target: string): void {
  const relativeTarget = relative(root, target)
  if (
    !relativeTarget
    || relativeTarget.startsWith('..')
    || isAbsolute(relativeTarget)
  ) {
    throw new Error('拒绝删除受管 Worktree 根之外的目录')
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
