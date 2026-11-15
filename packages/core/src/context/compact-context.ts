import type { ModelMessage } from 'ai'
import { isProjectInstructionsMessage } from '../instructions/project.ts'
import { isCompactApplicationContextMessage } from '../prompts/compact.ts'
import { isSkillCatalogMessage } from '../skills/context.ts'
import { SKILL_FILE_NAME } from '../skills/types.ts'
import { withoutSubagentCatalog } from '../subagents/context.ts'
import { withoutMcpToolState } from '../mcp/state.ts'
import { BROWSER_GUIDE } from '../tools/browser/guide.ts'
import { isTaskProgressReminder } from '../tasks/reminder.ts'
import { userTurn } from './user-turn.ts'

/** 按应用拥有的结构剥离可重建控制上下文；普通用户正文和实际读取资料不按标签搜索删除。 */
export function compactionConversation(messages: readonly ModelMessage[]): ModelMessage[] {
  const skillBodies = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type !== 'tool-call' || part.toolName !== 'Skill') continue
      const input = part.input as { resourcePath?: unknown } | null
      if (input && (input.resourcePath === undefined || input.resourcePath === SKILL_FILE_NAME)) {
        skillBodies.add(part.toolCallId)
      }
    }
  }
  const conversation = new Set(withoutSubagentCatalog(withoutMcpToolState(messages)))
  return messages.flatMap(message => {
    if (userTurn(message)) return [message]
    if (!conversation.has(message)) return []
    if (isProjectInstructionsMessage(message) || isSkillCatalogMessage(message)
      || isCompactApplicationContextMessage(message) || isTaskProgressReminder(message)) return []
    if (message.role === 'user' && typeof message.content === 'string') {
      const text = message.content
      if (text === BROWSER_GUIDE
        || /^<system-reminder>\n<whycode-subagent-turn-state version="2">\n/u.test(text)
        || text.startsWith('<system-reminder>\n\n以下 Skill 仅在当前根任务中激活，请遵循其正文。\n\n')) return []
    }
    if (message.role !== 'tool' || skillBodies.size === 0) return [message]
    return [{ ...message, content: message.content.map(part => {
      if (part.type !== 'tool-result' || part.output.type !== 'text' || !skillBodies.has(part.toolCallId)) return part
      return { ...part, output: { ...part.output, value: '[Skill 规范正文由应用按当前激活状态重新提供]' } }
    }) }]
  })
}
