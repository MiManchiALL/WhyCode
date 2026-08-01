import type { ModelMessage } from 'ai'
import { isProjectInstructionsMessage } from '../instructions/project.ts'
import type { ActivatedSkill, SkillTurnSnapshot } from './types.ts'
import { escapeSkillXmlAttribute } from './xml.ts'

const EXPIRED_SKILL_RESULT = '[Skill 工具正文不作为长期历史；当前根任务需要时由活动 Skill 上下文重新注入]'

export function skillCatalogMessage(snapshot: SkillTurnSnapshot): ModelMessage | null {
  if (!snapshot.modelContext) return null
  return {
    role: 'user',
    content: [
      '<system-reminder>',
      `<whycode-skill-catalog revision="${snapshot.revision}">`,
      snapshot.modelContext,
      '</whycode-skill-catalog>',
      '</system-reminder>',
    ].join('\n'),
  }
}

export function activeSkillsMessage(skills: readonly ActivatedSkill[]): ModelMessage | null {
  if (skills.length === 0) return null
  const sections = skills.map((skill) => [
    '<whycode-active-skill'
      + ` id="${escapeSkillXmlAttribute(skill.id)}"`
      + ` digest="${escapeSkillXmlAttribute(skill.digest)}"`
      + ` path="${escapeSkillXmlAttribute(skill.path)}">`,
    skill.content,
    '</whycode-active-skill>',
  ].join('\n'))
  return {
    role: 'user',
    content: [
      '<system-reminder>',
      '用户已为当前根任务显式选择以下 Skill。立即遵循；仅对当前根任务有效，不向下一根任务继承。',
      ...sections,
      '</system-reminder>',
    ].join('\n\n'),
  }
}

/** 请求时投影，不写入长期消息历史；同时冻结上一根任务的 Skill 工具输出语义。 */
export function applySkillContext(
  messages: readonly ModelMessage[],
  catalog: SkillTurnSnapshot | null,
  activeSkills: readonly ActivatedSkill[],
  preservedSkillResultCallIds: ReadonlySet<string>,
): ModelMessage[] {
  const projected = expirePreviousSkillResults(messages, preservedSkillResultCallIds)
  const catalogReminder = catalog ? skillCatalogMessage(catalog) : null
  const activeReminder = activeSkillsMessage(activeSkills)
  if (!catalogReminder && !activeReminder) return projected
  const firstConversationIndex = projected[0] && isProjectInstructionsMessage(projected[0]) ? 1 : 0
  return [
    ...projected.slice(0, firstConversationIndex),
    ...(catalogReminder ? [catalogReminder] : []),
    ...projected.slice(firstConversationIndex),
    // 活动正文紧贴本次请求尾部，避免每个新根任务改写整段历史的缓存前缀。
    ...(activeReminder ? [activeReminder] : []),
  ]
}

function expirePreviousSkillResults(
  messages: readonly ModelMessage[],
  preservedSkillResultCallIds: ReadonlySet<string>,
): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== 'tool' || typeof message.content === 'string') return message
    let changed = false
    const content = message.content.map((part) => {
      if (
        part.type !== 'tool-result'
        || part.toolName !== 'Skill'
        || preservedSkillResultCallIds.has(part.toolCallId)
      ) return part
      changed = true
      return { ...part, output: { type: 'text' as const, value: EXPIRED_SKILL_RESULT } }
    })
    return changed ? { ...message, content } : message
  })
}
