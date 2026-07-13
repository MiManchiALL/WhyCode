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
  onDeletionMarked?: (sessionExists: boolean) => void
}

/**
 * 先持久标成 delete-only，再把会话事实源放在最后删除；中途失败仍可见且只能重试。
 * 用户项目文件不属于会话存储，绝不在此生命周期内处理。
 */
export async function deleteSessionArtifacts(
  options: SessionDeletionOptions,
): Promise<boolean> {
  validateSessionId(options.sessionId)
  const sessionExists = await options.sessions.markDeleting(options.sessionId)
  options.onDeletionMarked?.(sessionExists)
  await options.commandSessions.removeSession(options.sessionId)
  await cleanupConversationScratch(options.scratchRoot, options.sessionId)
  return options.sessions.delete(options.sessionId)
}
