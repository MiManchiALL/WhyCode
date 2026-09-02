import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { ToolCheckpointScope } from '../tools/tool.ts'
import { captureFileState } from './file-history.ts'
import { CheckpointManifestStore } from './manifest-store.ts'
import { ResourceRestoreTransaction } from './restore-transaction.ts'
import {
  CHECKPOINT_MANIFEST_VERSION,
  type CheckpointManifest,
  type CheckpointResource,
  type FileState,
  type PreparedCheckpoint,
  type ReadyCheckpoint,
} from './types.ts'

export interface CheckpointManagerOptions {
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

type RestoreCheckpointPlan =
  | {
      available: true
      turnId: string
      manifests: CheckpointManifest[]
    }
  | {
      available: false
      result: RestoreCheckpointResult
    }

function pathKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function uniquePaths(paths: string[]): string[] {
  return [...new Map(paths.map((path) => [pathKey(path), resolve(path)])).values()]
}

function sameFileState(left: FileState, right: FileState): boolean {
  return left.kind === right.kind && (
    left.kind === 'missing' || left.contentHash === right.contentHash
  )
}

/**
 * 持久化精确文件检查点。manifest 与 blob 都归属会话目录，切换会话或重启后仍可恢复。
 * 未声明精确资源的写操作只形成安全屏障，不尝试推断或扫描其副作用。
 */
export class CheckpointManager {
  private readonly sessionId: string
  private readonly store: CheckpointManifestStore
  private disabledReason: string | null = null

  constructor(options: CheckpointManagerOptions) {
    this.sessionId = options.sessionId
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
      const resources: CheckpointResource[] = await Promise.all(
        uniquePaths(scope.paths).map(async (path) => ({
          kind: 'exact-file' as const,
          path,
          before: await captureFileState(path, this.store.blobDir),
        })),
      )
      if (resources.length === 0) {
        this.disabledReason = '工具没有可捕获的文件'
        return null
      }

      await this.store.put({
        version: CHECKPOINT_MANIFEST_VERSION,
        id,
        sessionId: this.sessionId,
        toolUseId,
        turnId,
        sequence: (previous.at(-1)?.sequence ?? 0) + 1,
        createdAt: new Date().toISOString(),
        coverage: 'complete',
        warnings: [],
        status: 'pending',
        resources,
      })
      return { id }
    } catch (error) {
      this.disabledReason = error instanceof Error ? error.message : String(error)
      return null
    }
  }

  /** 记录未跟踪副作用边界；跨边界只允许带 after 冲突检测的“仅文件”恢复。 */
  async recordBarrier(toolUseId: string, turnId: string, warning: string): Promise<void> {
    const previous = await this.store.list()
    await this.store.put({
      version: CHECKPOINT_MANIFEST_VERSION,
      id: randomUUID(),
      sessionId: this.sessionId,
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
        const after = await captureFileState(resource.path, this.store.blobDir)
        if (!sameFileState(resource.before, after)) resources.push({ ...resource, after })
      }
      if (resources.length === 0) {
        await this.store.remove(manifest.id)
        return null
      }
      const ready: CheckpointManifest = { ...manifest, resources, status: 'ready' }
      if (ready.resources.some((resource) => !resource.after)) {
        throw new Error('检查点 after 状态不完整')
      }
      await this.store.put(ready)
      return { id: ready.id, toolUseId: ready.toolUseId, turnId: ready.turnId }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.disabledReason = reason
      const pending = await this.store.get(prepared.id).catch(() => null)
      if (pending?.status === 'pending') {
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
    const plan = await this.planRestore(toolUseId, scope)
    if (!plan.available) return plan.result

    const transaction = new ResourceRestoreTransaction({
      manifests: plan.manifests,
      blobDir: this.store.blobDir,
    })
    let hookStarted = false
    try {
      await transaction.apply()
      if (hooks) {
        hookStarted = true
        await hooks.commit()
      }
      for (const manifest of plan.manifests) {
        await this.store.put({ ...manifest, status: 'invalidated' })
      }
    } catch (error) {
      const compensationErrors: unknown[] = []
      if (hookStarted && hooks) {
        await hooks.compensate().catch((compensation) => compensationErrors.push(compensation))
      }
      await transaction.compensate()
        .catch((compensation) => compensationErrors.push(compensation))
      for (const manifest of plan.manifests) {
        await this.store.put(manifest).catch((compensation) => compensationErrors.push(compensation))
      }
      const detail = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        turnId: plan.turnId,
        error: compensationErrors.length > 0
          ? `${detail}；安全补偿也失败：${compensationErrors.map((item) => item instanceof Error ? item.message : String(item)).join('；')}`
          : detail,
      }
    }

    return {
      ok: true,
      turnId: plan.turnId,
      invalidatedToolUseIds: plan.manifests.map((item) => item.toolUseId),
    }
  }

  /** 在展示二次确认前只读验证恢复范围与文件冲突；实际恢复时仍会再次校验。 */
  async checkRestore(
    toolUseId: string,
    scope: 'files' | 'files-and-chat',
  ): Promise<RestoreCheckpointResult> {
    const plan = await this.planRestore(toolUseId, scope)
    if (!plan.available) return plan.result
    try {
      await new ResourceRestoreTransaction({
        manifests: plan.manifests,
        blobDir: this.store.blobDir,
      }).validate()
      return {
        ok: true,
        turnId: plan.turnId,
        invalidatedToolUseIds: plan.manifests.map((item) => item.toolUseId),
      }
    } catch (error) {
      return {
        ok: false,
        turnId: plan.turnId,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async planRestore(
    toolUseId: string,
    scope: 'files' | 'files-and-chat',
  ): Promise<RestoreCheckpointPlan> {
    const ready = (await this.store.list()).filter((item) => item.status === 'ready')
    const selected = ready.find((item) => item.toolUseId === toolUseId)
    if (!selected || selected.coverage !== 'complete') {
      return {
        available: false,
        result: { ok: false, error: '该操作没有可用的精确文件检查点' },
      }
    }
    const target = scope === 'files-and-chat'
      ? (ready.find((item) => item.turnId === selected.turnId) ?? selected)
      : selected
    const range = ready.filter((item) => item.sequence >= target.sequence)
    if (scope === 'files-and-chat' && range.some((item) => item.coverage !== 'complete')) {
      return {
        available: false,
        result: {
          ok: false,
          turnId: selected.turnId,
          error: '这段范围包含命令或其他未跟踪写操作；只能回滚专用文件工具跟踪的文件，不能同时截断对话',
        },
      }
    }
    return {
      available: true,
      turnId: selected.turnId,
      manifests: range.filter((item) => item.coverage === 'complete'),
    }
  }

  async getReady(toolUseId: string): Promise<ReadyCheckpoint | null> {
    const manifest = (await this.store.list()).find(
      (item) => item.status === 'ready' && item.coverage === 'complete' && item.toolUseId === toolUseId,
    )
    return manifest
      ? { id: manifest.id, toolUseId: manifest.toolUseId, turnId: manifest.turnId }
      : null
  }
}
