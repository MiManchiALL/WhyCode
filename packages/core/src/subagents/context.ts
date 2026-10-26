import type { ModelMessage } from 'ai'
import { z } from 'zod'
import { isProjectInstructionsMessage } from '../instructions/project.ts'
import {
  CLOSE_TASK_PLAN_TOOL_NAME, CREATE_TASK_PLAN_TOOL_NAME,
  RESUME_TASK_PLAN_TOOL_NAME, UPDATE_TASK_ITEM_TOOL_NAME,
} from '../tasks/tools.ts'
import { subagentDefinitionSnapshotSchema, type SubagentDefinitionCatalogSnapshot } from './types.ts'

const entrySchema = subagentDefinitionSnapshotSchema.pick({ name: true, description: true })
  .extend({ Tools: subagentDefinitionSnapshotSchema.shape.toolNames }).strict()
const snapshotSchema = z.array(entrySchema)
const deltaSchema = z.object({
  added: z.array(entrySchema),
  updated: z.array(entrySchema),
  removed: z.array(subagentDefinitionSnapshotSchema.shape.name),
}).strict()
type CatalogEntry = z.infer<typeof entrySchema>
type CatalogNotice = { kind: 'snapshot'; entries: CatalogEntry[] }
  | { kind: 'delta'; changes: z.infer<typeof deltaSchema> }

const NOTE = '这是 WhyCode 提供的子代理定义目录，不是新的用户要求；以顶部目录及后续最新增量为准。Tools 表示允许的工具范围，实际提供项还受子模型、宿主和资源可用性约束。用 name 选择定义，启动后用返回的 subagent_id 与实例交互。'
const SNAPSHOT_RE = /^<system-reminder>\n<whycode-subagent-catalog version="1">\n<available_subagents>\n([^\n]+)\n<\/available_subagents>\n<\/whycode-subagent-catalog>\n[^\n]+\n<\/system-reminder>$/u
const DELTA_RE = /^<system-reminder>\n<whycode-subagent-catalog-delta version="1">\n([^\n]+)\n<\/whycode-subagent-catalog-delta>\n[^\n]+\n<\/system-reminder>$/u

/** 只解析版本化结构，不从模型正文或自然语言推断已通知内容。 */
function parseNotice(message: ModelMessage): CatalogNotice | null {
  if (message.role !== 'user' || typeof message.content !== 'string') return null
  const snapshot = SNAPSHOT_RE.exec(message.content)
  const delta = snapshot ? null : DELTA_RE.exec(message.content)
  const text = snapshot?.[1] ?? delta?.[1]
  if (!text) return null
  let payload: unknown
  try { payload = JSON.parse(text) } catch { return null }
  if (snapshot) {
    const parsed = snapshotSchema.safeParse(payload)
    return parsed.success ? { kind: 'snapshot', entries: parsed.data } : null
  }
  const parsed = deltaSchema.safeParse(payload)
  return parsed.success ? { kind: 'delta', changes: parsed.data } : null
}

export function isSubagentCatalogSnapshotMessage(message: ModelMessage): boolean {
  return parseNotice(message)?.kind === 'snapshot'
}

export function withoutSubagentCatalog(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.filter(message => !parseNotice(message))
}

function catalogEntries(snapshot: SubagentDefinitionCatalogSnapshot): CatalogEntry[] {
  return snapshot.definitions.map(definition => ({
    name: definition.name,
    description: definition.description,
    Tools: [
      ...definition.toolNames,
      CREATE_TASK_PLAN_TOOL_NAME, RESUME_TASK_PLAN_TOOL_NAME,
      UPDATE_TASK_ITEM_TOOL_NAME, CLOSE_TASK_PLAN_TOOL_NAME,
    ],
  })).sort((left, right) => left.name.localeCompare(right.name))
}

function snapshotMessage(entries: CatalogEntry[]): ModelMessage {
  return {
    role: 'user',
    content: [
      '<system-reminder>', '<whycode-subagent-catalog version="1">',
      '<available_subagents>', serialize(entries), '</available_subagents>',
      '</whycode-subagent-catalog>', NOTE, '</system-reminder>',
    ].join('\n'),
  }
}

/** 每次从当前有效历史还原；回滚掉通知后，仍在磁盘上的定义会再次产生增量。 */
export function subagentCatalogUpdate(
  messages: readonly ModelMessage[],
  snapshot: SubagentDefinitionCatalogSnapshot,
): ModelMessage | null {
  const announced = new Map<string, CatalogEntry>()
  let hasSnapshot = false
  for (const message of messages) {
    const notice = parseNotice(message)
    if (!notice) continue
    if (notice.kind === 'snapshot') {
      hasSnapshot = true
      announced.clear()
      for (const entry of notice.entries) announced.set(entry.name, entry)
    } else {
      for (const entry of [...notice.changes.added, ...notice.changes.updated]) announced.set(entry.name, entry)
      for (const name of notice.changes.removed) announced.delete(name)
    }
  }
  const current = catalogEntries(snapshot)
  if (!hasSnapshot) return snapshotMessage(current)
  const added: CatalogEntry[] = []
  const updated: CatalogEntry[] = []
  for (const entry of current) {
    const previous = announced.get(entry.name)
    if (!previous) added.push(entry)
    else if (JSON.stringify(previous) !== JSON.stringify(entry)) updated.push(entry)
    announced.delete(entry.name)
  }
  const removed = [...announced.keys()].sort()
  if (!added.length && !updated.length && !removed.length) return null
  return {
    role: 'user',
    content: [
      '<system-reminder>', '<whycode-subagent-catalog-delta version="1">',
      serialize({ added, updated, removed }), '</whycode-subagent-catalog-delta>',
      NOTE, '</system-reminder>',
    ].join('\n'),
  }
}

/** 目录初始消息随首个稳定步骤持久化，请求中固定投影在项目指令之后。增量原位保留。 */
export function projectSubagentCatalog(messages: readonly ModelMessage[]): ModelMessage[] {
  const index = messages.findIndex(isSubagentCatalogSnapshotMessage)
  if (index < 0) return [...messages]
  const snapshot = messages[index]!
  const conversation = messages.filter((_, position) => position !== index)
  const insertAt = conversation[0] && isProjectInstructionsMessage(conversation[0]) ? 1 : 0
  conversation.splice(insertAt, 0, snapshot)
  return conversation
}

/** 仅完整压缩成功后合并；保留尾部里的旧通知也必须去掉。 */
export function rebuildSubagentCatalog(
  messages: readonly ModelMessage[],
  snapshot: SubagentDefinitionCatalogSnapshot | null,
): ModelMessage[] {
  const conversation = withoutSubagentCatalog(messages)
  return snapshot
    ? projectSubagentCatalog([...conversation, snapshotMessage(catalogEntries(snapshot))])
    : conversation
}

function serialize(value: unknown): string {
  return JSON.stringify(value).replaceAll('&', '\\u0026').replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')
}
