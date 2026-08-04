import {
  cleanupConversationScratch,
  validateSessionId,
  type CommandSessionManager,
} from '@whycode/core'
import type { DesktopSessionRepository } from './session-repository.ts'

interface SessionDeletionOptions {
  sessionId: string
  sessions: Pick<DesktopSessionRepository, 'markDeleting' | 'delete'>
  commandSessions: Pick<CommandSessionManager, 'removeSession'>
  scratchRoot: string
  onDeletionMarked?: (sessionExists: boolean) => void | Promise<void>
  /** 删除标记已生效、目标会话已不可恢复，但事实源尚在，供引用型元数据完成原子收尾。 */
  onBeforeFactSourceDelete?: () => Promise<void>
}

/**
 * 先持久标成 delete-only，再把会话事实源放在最后删除；中途失败仍可见且只能重试。
 * Local 用户目录始终不处理；Worktree、默认会话目录等 app-owned 资源由收尾回调
 * 在事实源删除前按各自所有权记录清理。
 */
export async function deleteSessionArtifacts(
  options: SessionDeletionOptions,
): Promise<boolean> {
  validateSessionId(options.sessionId)
  const sessionExists = await options.sessions.markDeleting(options.sessionId)
  await options.onDeletionMarked?.(sessionExists)
  await options.commandSessions.removeSession(options.sessionId)
  await cleanupConversationScratch(options.scratchRoot, options.sessionId)
  await options.onBeforeFactSourceDelete?.()
  return options.sessions.delete(options.sessionId)
}
