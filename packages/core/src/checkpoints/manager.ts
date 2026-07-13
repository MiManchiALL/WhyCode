import { randomUUID } from 'node:crypto'
import { relative, resolve } from 'node:path'
import type { ToolCheckpointScope } from '../tools/tool.ts'
import { captureFileState } from './file-history.ts'
import { CheckpointManifestStore } from './manifest-store.ts'
import { ResourceRestoreTransaction } from './restore-transaction.ts'
import { ShadowRepository, releaseShadowRefs } from './shadow-repository.ts'
import {
  CHECKPOINT_MANIFEST_VERSION,
  type CheckpointManifest,
  type CheckpointResource,
  type FileState,
  type PreparedCheckpoint,
  type ReadyCheckpoint,
} from './types.ts'

export interface CheckpointManagerOptions {
  projectDir: string
  storageRoot: string
  sessionDir: string
  sessionId: string
}

export interface RestoreCheckpointResult {
  ok: boolean
  turnId?: string
  invalidatedToolUseIds?: string[]
  error?: string
}

export interface RestoreTransactionHooks {
  commit: () => Promise<void>
  compensate: () => Promise<void>
}

function pathKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function uniquePaths(paths: string[]): string[] {
  return [...new Map(paths.map((path) => [pathKey(path), resolve(path)])).values()]
}

function dedupeRoots(roots: string[]): string[] {
  const sorted = uniquePaths(roots).sort((left, right) => left.length - right.length)
  return sorted.filter((candidate, index) =>
    !sorted.slice(0, index).some((parent) => {
      const rel = relative(parent, candidate)
      return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel))
    }),
  )
}

function sameFileState(left: FileState, right: FileState): boolean {
  return left.kind === right.kind && (
    left.kind === 'missing' || left.contentHash === right.contentHash
  )
}

function readyResource(resource: CheckpointResource): boolean {
  return resource.kind === 'exact-file'
    ? resource.after !== undefined
    : resource.afterHash !== undefined && resource.changedPaths !== undefined
}

/**
 * 持久化资源检查点：精确文件备份负责完整性，Shadow Git 只作为命令型批量变更的内容后端。
 * manifest 才是回滚事实源，因此切换会话和重启后仍能恢复同一批资源边界。
 */
export class CheckpointManager {
  private readonly options: CheckpointManagerOptions
  private readonly store: CheckpointManifestStore
  private readonly repositories = new Map<string, ShadowRepository>()
  private disabledReason: string | null = null

  constructor(options: CheckpointManagerOptions) {
    this.options = { ...options, projectDir: resolve(options.projectDir) }
    this.store = new CheckpointManifestStore(options.sessionDir)
  }

  get disabled(): string | null {
    return this.disabledReason
  }

  async prepare(
    toolUseId: string,
    turnId: string,
    scope: ToolCheckpointScope,
  ): Promise<PreparedCheckpoint | null> {
    this.disabledReason = null
    try {
      const previous = await this.store.list()
      const id = randomUUID()
      const warnings: string[] = []
      let coverage: CheckpointManifest['coverage'] = 'complete'
      let resources: CheckpointResource[] = []

      if (scope.kind === 'exact-files') {
        resources = await Promise.all(uniquePaths(scope.paths).map(async (path) => ({
          kind: 'exact-file' as const,
          path,
          before: await captureFileState(path, this.store.blobDir),
        })))
      } else {
        coverage = 'partial'
        warnings.push(scope.warning)
        for (const root of dedupeRoots(scope.roots)) {
          try {
            const repo = this.repository(root)
            resources.push({
              kind: 'tree',
              root,
              beforeHash: await repo.capture(this.options.sessionId, id, 'before'),
            })
          } catch (error) {
            warnings.push(`未覆盖 ${root}：${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      if (resources.length === 0) {
        this.disabledReason = warnings.join('；') || '工具没有可捕获的资源'
        return null
      }

      await this.store.put({
        version: CHECKPOINT_MANIFEST_VERSION,
        id,
        sessionId: this.options.sessionId,
        toolUseId,
        turnId,
        sequence: (previous.at(-1)?.sequence ?? 0) + 1,
        createdAt: new Date().toISOString(),
        coverage,
        warnings,
        status: 'pending',
        resources,
      })
      return { id }
    } catch (error) {
      this.disabledReason = error instanceof Error ? error.message : String(error)
      return null
    }
  }

  /** 未声明资源契约或快照失败的写操作形成覆盖屏障，阻止旧检查点越过它误报成功。 */
  async recordBarrier(toolUseId: string, turnId: string, warning: string): Promise<void> {
    const previous = await this.store.list()
    await this.store.put({
      version: CHECKPOINT_MANIFEST_VERSION,
      id: randomUUID(),
      sessionId: this.options.sessionId,
      toolUseId,
      turnId,
      sequence: (previous.at(-1)?.sequence ?? 0) + 1,
      createdAt: new Date().toISOString(),
      coverage: 'none',
      warnings: [warning],
      status: 'ready',
      resources: [],
    })
  }

  /** 工具结束后补齐 after 状态；没有实际文件变化时不生成可见回滚点。 */
  async finalize(prepared: PreparedCheckpoint): Promise<ReadyCheckpoint | null> {
    try {
      const manifest = await this.store.get(prepared.id)
      if (!manifest || manifest.status !== 'pending') return null
      const resources: CheckpointResource[] = []
      for (const resource of manifest.resources) {
        if (resource.kind === 'exact-file') {
          const after = await captureFileState(resource.path, this.store.blobDir)
          if (!sameFileState(resource.before, after)) resources.push({ ...resource, after })
          continue
        }
        const repo = this.repository(resource.root)
        const afterHash = await repo.capture(
          this.options.sessionId,
          manifest.id,
          'after',
        )
        const changedPaths = await repo.changedPaths(resource.beforeHash, afterHash)
        if (changedPaths.length > 0) resources.push({ ...resource, afterHash, changedPaths })
      }
      if (resources.length === 0) {
        const uncovered = manifest.warnings.filter((warning) => warning.startsWith('未覆盖 '))
        if (uncovered.length > 0) {
          this.disabledReason = `命令涉及的路径未进入可回滚范围：${uncovered.join('；')}`
        }
        await this.releaseManifestRefs(manifest)
        await this.store.remove(manifest.id)
        return null
      }
      const ready: CheckpointManifest = { ...manifest, resources, status: 'ready' }
      if (!ready.resources.every(readyResource)) throw new Error('检查点 after 状态不完整')
      await this.store.put(ready)
      return {
        id: ready.id,
        toolUseId: ready.toolUseId,
        turnId: ready.turnId,
        coverage: ready.coverage as 'complete' | 'partial',
        warning: ready.warnings.join('；') || undefined,
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.disabledReason = reason
      const pending = await this.store.get(prepared.id).catch(() => null)
      if (pending?.status === 'pending') {
        await this.releaseManifestRefs(pending).catch(() => {})
        await this.store.put({
          ...pending,
          coverage: 'none',
          warnings: [...pending.warnings, `检查点收尾失败：${reason}`],
          status: 'ready',
          resources: [],
        }).catch(() => {})
      }
      return null
    }
  }

  async restore(
    toolUseId: string,
    scope: 'files' | 'files-and-chat',
    hooks?: RestoreTransactionHooks,
  ): Promise<RestoreCheckpointResult> {
    const ready = (await this.store.list()).filter((item) => item.status === 'ready')
    const selected = ready.find((item) => item.toolUseId === toolUseId)
    if (!selected || selected.coverage === 'none') {
      return { ok: false, error: '该操作没有可用检查点' }
    }
    const target = scope === 'files-and-chat'
      ? (ready.find((item) => item.turnId === selected.turnId) ?? selected)
      : selected
    const manifests = ready.filter((item) => item.sequence >= target.sequence)
    if (manifests.some((item) => item.coverage === 'none')) {
      return {
        ok: false,
        turnId: selected.turnId,
        error: '目标之后存在未覆盖的写操作，无法保证安全恢复',
      }
    }
    if (scope === 'files-and-chat' && manifests.some((item) => item.coverage !== 'complete')) {
      return {
        ok: false,
        turnId: selected.turnId,
        error: '这段操作包含部分覆盖的命令检查点，只能回滚已覆盖文件，不能同时截断对话',
      }
    }

    const transaction = new ResourceRestoreTransaction({
      manifests,
      blobDir: this.store.blobDir,
      sessionId: this.options.sessionId,
      repository: (root) => this.repository(root),
    })
    let hookStarted = false
    try {
      await transaction.apply()
      if (hooks) {
        hookStarted = true
        await hooks.commit()
      }
      for (const manifest of manifests) {
        await this.store.put({ ...manifest, status: 'invalidated' })
      }
    } catch (error) {
      const compensationErrors: unknown[] = []
      if (hookStarted && hooks) {
        await hooks.compensate().catch((compensation) => compensationErrors.push(compensation))
      }
      await transaction.compensate()
        .catch((compensation) => compensationErrors.push(compensation))
      for (const manifest of manifests) {
        await this.store.put(manifest).catch((compensation) => compensationErrors.push(compensation))
      }
      await transaction.releaseTransientRefs()
      const detail = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        turnId: selected.turnId,
        error: compensationErrors.length > 0
          ? `${detail}；安全补偿也失败：${compensationErrors.map((item) => item instanceof Error ? item.message : String(item)).join('；')}`
          : detail,
      }
    }

    await transaction.releaseTransientRefs()
    for (const manifest of manifests) {
      await this.releaseManifestRefs(manifest).catch(() => {})
    }
    return {
      ok: true,
      turnId: selected.turnId,
      invalidatedToolUseIds: manifests.map((item) => item.toolUseId),
    }
  }

  async getReady(toolUseId: string): Promise<ReadyCheckpoint | null> {
    const manifest = (await this.store.list()).find(
      (item) => item.status === 'ready' && item.coverage !== 'none' && item.toolUseId === toolUseId,
    )
    return manifest ? {
      id: manifest.id,
      toolUseId: manifest.toolUseId,
      turnId: manifest.turnId,
      coverage: manifest.coverage as 'complete' | 'partial',
      warning: manifest.warnings.join('；') || undefined,
    } : null
  }

  private repository(root: string): ShadowRepository {
    const key = pathKey(root)
    let repository = this.repositories.get(key)
    if (!repository) {
      repository = new ShadowRepository(root, this.options.storageRoot)
      this.repositories.set(key, repository)
    }
    return repository
  }

  private async releaseManifestRefs(manifest: CheckpointManifest): Promise<void> {
    const roots = uniquePaths(manifest.resources.flatMap((resource) =>
      resource.kind === 'tree' ? [resource.root] : [],
    ))
    await Promise.all(roots.map((root) =>
      this.repository(root).deleteCheckpointRefs(manifest.sessionId, manifest.id),
    ))
  }

}

export { releaseShadowRefs }
