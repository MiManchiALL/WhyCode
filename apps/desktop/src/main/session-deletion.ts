import {
  validateSessionId,
  type CommandSessionManager,
} from '@whycode/core'
import type { DesktopSessionRepository } from './session-repository.ts'
import type { SessionScratchManager } from './session-scratch.ts'

interface SessionDeletionOptions {
  sessionId: string
  sessions: Pick<DesktopSessionRepository, 'markDeleting' | 'delete'>
  commandSessions: Pick<CommandSessionManager, 'removeSession'>
  scratch: Pick<SessionScratchManager, 'remove'>
  /** 删除标记已提交后关闭仍引用目标目录的运行时资源。 */
  onBeforeArtifactsDelete?: () => Promise<void>
  /** 删除标记已生效、目标会话已不可恢复，但事实源尚在，供引用型元数据完成原子收尾。 */
  onBeforeFactSourceDelete?: () => Promise<void>
}

export interface StagedSessionDeletion {
  sessionExists: boolean
  finish(): Promise<boolean>
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
  let finishing: Promise<boolean> | null = null
  return {
    sessionExists,
    finish() {
      finishing ??= finishSessionDeletion(options)
      return finishing
    },
  }
}

async function finishSessionDeletion(options: SessionDeletionOptions): Promise<boolean> {
  await options.onBeforeArtifactsDelete?.()
  await options.commandSessions.removeSession(options.sessionId)
  await options.scratch.remove(options.sessionId)
  await options.onBeforeFactSourceDelete?.()
  return options.sessions.delete(options.sessionId)
}
