import {
  validateSessionId,
  type CommandSessionManager,
  type WorkspaceBinding,
} from '@whycode/core'
import type { DesktopSessionRepository } from './session-repository.ts'
import type { SessionScratchManager } from './session-scratch.ts'
import type { ManagedWorkspaceManager } from './workspace.ts'
import type { WorktreeManager } from './worktree-manager.ts'
import { WorkspaceOwnershipError } from './workspace-ownership-error.ts'

interface SessionDeletionOptions {
  sessionId: string
  sessions: Pick<DesktopSessionRepository, 'markDeleting' | 'delete'>
  commandSessions: Pick<CommandSessionManager, 'removeSession'>
  scratch: Pick<SessionScratchManager, 'remove'>
  /** 删除标记已提交后关闭仍引用目标目录的运行时资源。 */
  onBeforeArtifactsDelete?: () => Promise<void>
  /** 删除标记已生效、目标会话已不可恢复，但事实源尚在，供引用型元数据完成原子收尾。 */
  onBeforeFactSourceDelete?: () => Promise<string | void>
}

interface FinishedSessionDeletion {
  deleted: boolean
  warning?: string
}

export interface StagedSessionDeletion {
  sessionExists: boolean
  finish(): Promise<FinishedSessionDeletion>
}

/**
 * 先持久标成 delete-only，再把会话事实源放在最后删除；中途失败仍可见且只能重试。
 * Local 用户目录始终不处理；Worktree、默认会话目录等 app-owned 资源由收尾回调
 * 在事实源删除前按各自所有权记录清理。
 */
export async function stageSessionDeletion(
  options: SessionDeletionOptions,
): Promise<StagedSessionDeletion> {
  validateSessionId(options.sessionId)
  const sessionExists = await options.sessions.markDeleting(options.sessionId)
  let finishing: Promise<FinishedSessionDeletion> | null = null
  return {
    sessionExists,
    finish() {
      finishing ??= finishSessionDeletion(options)
      return finishing
    },
  }
}

async function finishSessionDeletion(options: SessionDeletionOptions): Promise<FinishedSessionDeletion> {
  await options.onBeforeArtifactsDelete?.()
  await options.commandSessions.removeSession(options.sessionId)
  await options.scratch.remove(options.sessionId)
  const warning = await options.onBeforeFactSourceDelete?.()
  const deleted = await options.sessions.delete(options.sessionId)
  return { deleted, ...(warning ? { warning } : {}) }
}

/** 清理只依据目标会话的归属；无法验证的项目文件保留，不阻塞历史删除。 */
export async function cleanupSessionWorkspace(
  sessionId: string,
  workspace: WorkspaceBinding | undefined,
  managed: Pick<ManagedWorkspaceManager, 'detachSession' | 'removeSession'>,
  worktrees: Pick<WorktreeManager, 'detachSession'>,
): Promise<string | undefined> {
  try {
    if (workspace?.mode === 'managed') {
      await managed.detachSession(workspace, sessionId)
    } else if (workspace?.mode === 'worktree') {
      await worktrees.detachSession(workspace, sessionId, true)
    } else if (!workspace) {
      const warnings = await managed.removeSession(sessionId)
      if (warnings.length) return '无法确认工作区归属，未验证的项目文件已保留。'
    }
  } catch (error) {
    if (!(error instanceof WorkspaceOwnershipError)) throw error
    return `${error.message}，项目文件已保留。`
  }
}
