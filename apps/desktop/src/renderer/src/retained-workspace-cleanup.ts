import type { RetainedWorkspace, RetainedWorkspaceTarget } from '../../shared/workspace-lifecycle.ts'

export function retainedWorkspaceKey(workspace: RetainedWorkspaceTarget): string {
  return `${workspace.mode}:${workspace.id}`
}

/** 清理归应用持有，设置页卸载只停止订阅，不改变进行中的磁盘操作。 */
export class RetainedWorkspaceCleanup {
  private pending: ReadonlySet<string> = new Set()
  private readonly listeners = new Set<() => void>()
  private readonly deleteWorkspace: (workspace: RetainedWorkspace) => Promise<void>
  private readonly onError: (message: string) => void

  constructor(deleteWorkspace: (workspace: RetainedWorkspace) => Promise<void>, onError: (message: string) => void) {
    this.deleteWorkspace = deleteWorkspace
    this.onError = onError
  }

  getSnapshot = (): ReadonlySet<string> => this.pending

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  remove = async (workspace: RetainedWorkspace): Promise<void> => {
    const key = retainedWorkspaceKey(workspace)
    if (this.pending.has(key)) return
    this.publish(new Set(this.pending).add(key))
    try {
      await this.deleteWorkspace(workspace)
    } catch (error) {
      this.onError(`清理工作区「${workspace.name}」失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      const next = new Set(this.pending)
      next.delete(key)
      this.publish(next)
    }
  }

  private publish(pending: ReadonlySet<string>): void {
    this.pending = pending
    for (const listener of this.listeners) listener()
  }
}
