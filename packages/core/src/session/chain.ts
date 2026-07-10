import type { ModelMessage } from 'ai'
import { keepsConsensusProgress } from '../consensus/types.ts'
import { sessionEntrySchema, type LoadedSession, type SessionEntry } from './types.ts'
import type { ViewEvent } from './view-events.ts'

export class SessionCorruptError extends Error {}

export function parseTranscript(text: string): SessionEntry[] {
  const lines = text.split('\n')
  const lastContentIndex = findLastContentIndex(lines)
  const entries: SessionEntry[] = []

  for (let i = 0; i <= lastContentIndex; i++) {
    const line = lines[i]!.trim()
    if (!line) continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      if (i === lastContentIndex) continue
      throw new SessionCorruptError(`会话记录第 ${i + 1} 行损坏`)
    }
    const parsed = sessionEntrySchema.safeParse(value)
    if (!parsed.success) throw new SessionCorruptError(`会话记录第 ${i + 1} 行结构无效`)
    entries.push(parsed.data)
  }
  if (entries.length === 0) throw new SessionCorruptError('会话记录为空或完全损坏')
  return entries
}

export function buildLoadedSession(entries: SessionEntry[]): LoadedSession {
  validateUniqueIds(entries)
  const starts = entries.filter((entry) => entry.type === 'session-start')
  if (starts.length !== 1 || entries[0]?.type !== 'session-start') {
    throw new SessionCorruptError('会话必须且只能以一个 session-start 开始')
  }
  const start = starts[0]!
  if (entries.some((entry) => entry.sessionId !== start.sessionId)) {
    throw new SessionCorruptError('会话记录混入了其他 sessionId')
  }
  validateEntrySemantics(entries)

  const chain = buildActiveChain(entries)
  const work = findInterruptedWork(chain)
  const messages = work.interruptedConsensusTaskId
    ? (work.interruptedConsensusBaseMessages ?? [])
    : collectMessages(chain)
  const consensusState = collectConsensusState(chain)
  const turnStartMessages = collectTurnStartMessages(chain)
  const viewEvents = collectViewEvents(entries)
  const modelId = collectModelId(chain, start.modelId)
  const { interruptedTurnId, interruptedConsensusTaskId, interruptedConsensusBaseMessages } = work
  const last = chain.at(-1)!
  const status = deriveStatus(chain, interruptedTurnId, interruptedConsensusTaskId)
  const recordedInputs = entries.flatMap((entry) => (entry.type === 'user-input' ? [entry.text] : []))
  const userTexts = recordedInputs.length > 0 ? recordedInputs : messages.flatMap(userText)

  return {
    entries,
    messages,
    viewEvents,
    turnStartMessages,
    leafUuid: last.uuid,
    interruptedTurnId,
    interruptedConsensusTaskId,
    interruptedConsensusBaseMessages,
    consensusState,
    metadata: {
      schemaVersion: 1,
      sessionId: start.sessionId,
      projectDir: start.projectDir,
      modelId,
      title: clip(userTexts[0] ?? ''),
      lastUserText: clip(userTexts.at(-1) ?? ''),
      createdAt: start.timestamp,
      updatedAt: last.timestamp,
      status,
    },
  }
}

function collectTurnStartMessages(chain: SessionEntry[]): Map<string, ModelMessage[]> {
  const starts = new Map<string, ModelMessage[]>()
  let messages: ModelMessage[] = []
  for (const entry of chain) {
    if (entry.type === 'snapshot') {
      starts.clear()
      messages = [...entry.messages]
      for (const start of entry.turnStartMessages ?? []) {
        starts.set(start.turnId, structuredClone(start.messages))
      }
    }
    if (entry.type === 'turn-start') starts.set(entry.turnId, structuredClone(messages))
    if (entry.type === 'messages') messages.push(...entry.messages)
    if (entry.type === 'consensus-task-end' && entry.rollbackMessages) {
      messages = [...entry.rollbackMessages]
    }
  }
  return starts
}

/** 可见时间线不随模型压缩换根；对话回滚由时间线中的 checkpoint-restored 事件重放。 */
function collectViewEvents(entries: SessionEntry[]): ViewEvent[] {
  return entries.flatMap((entry) => (entry.type === 'view-events' ? entry.events : []))
}

function findLastContentIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim()) return i
  }
  return -1
}

function validateUniqueIds(entries: SessionEntry[]): void {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (ids.has(entry.uuid)) throw new SessionCorruptError(`会话记录包含重复 UUID：${entry.uuid}`)
    ids.add(entry.uuid)
  }
}

function validateEntrySemantics(entries: SessionEntry[]): void {
  for (const entry of entries) {
    if (entry.type === 'snapshot') {
      const hasTask = entry.activeConsensusTaskId !== null
      const hasBase = entry.activeConsensusBaseMessages !== null
      if (hasTask !== hasBase || (hasTask && entry.consensusState === null)) {
        throw new SessionCorruptError('snapshot 的活动共识边界不完整')
      }
    }
    if (entry.type === 'consensus-task-end') {
      const shouldRollback = !keepsConsensusProgress(entry.outcome)
      if (shouldRollback !== (entry.rollbackMessages !== null)) {
        throw new SessionCorruptError('共识任务终点的回滚语义无效')
      }
    }
  }
}

function buildActiveChain(entries: SessionEntry[]): SessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.uuid, entry]))
  const chain: SessionEntry[] = []
  const seen = new Set<string>()
  let current: SessionEntry | undefined = entries.at(-1)

  while (current) {
    if (seen.has(current.uuid)) throw new SessionCorruptError(`会话父链存在循环：${current.uuid}`)
    seen.add(current.uuid)
    chain.push(current)
    if (current.parentUuid === null) break
    current = byId.get(current.parentUuid)
    if (!current) throw new SessionCorruptError('会话父链指向不存在的记录')
  }
  chain.reverse()
  const root = chain[0]
  if (root?.type !== 'session-start' && root?.type !== 'snapshot') {
    throw new SessionCorruptError('活动父链必须从 session-start 或 snapshot 开始')
  }
  return chain
}

function collectMessages(chain: SessionEntry[]): ModelMessage[] {
  let messages: ModelMessage[] = []
  for (const entry of chain) {
    if (entry.type === 'snapshot') messages = [...entry.messages]
    if (entry.type === 'messages') messages.push(...entry.messages)
    if (entry.type === 'consensus-task-end' && entry.rollbackMessages) {
      messages = [...entry.rollbackMessages]
    }
  }
  return messages
}

function collectConsensusState(chain: SessionEntry[]): LoadedSession['consensusState'] {
  let state: LoadedSession['consensusState'] = null
  for (const entry of chain) {
    if (entry.type === 'snapshot') state = entry.consensusState
    if (entry.type === 'consensus-task-start' || entry.type === 'consensus-task-end') {
      state = entry.state
    }
  }
  return state
}

function collectModelId(chain: SessionEntry[], initialModelId: string): string {
  let modelId = initialModelId
  for (const entry of chain) {
    if (entry.type === 'snapshot' || entry.type === 'model-change') modelId = entry.modelId
  }
  return modelId
}

function findInterruptedWork(chain: SessionEntry[]): {
  interruptedTurnId: string | null
  interruptedConsensusTaskId: string | null
  interruptedConsensusBaseMessages: ModelMessage[] | null
} {
  let interruptedTurnId: string | null = null
  let interruptedConsensusTaskId: string | null = null
  let interruptedConsensusBaseMessages: ModelMessage[] | null = null
  let visibleMessages: ModelMessage[] = []
  for (const entry of chain) {
    if (entry.type === 'snapshot') {
      visibleMessages = [...entry.messages]
      interruptedTurnId = entry.activeTurnId
      interruptedConsensusTaskId = entry.activeConsensusTaskId
      interruptedConsensusBaseMessages = entry.activeConsensusBaseMessages
    }
    if (entry.type === 'messages') visibleMessages.push(...entry.messages)
    if (entry.type === 'turn-start') interruptedTurnId = entry.turnId
    if (entry.type === 'turn-end' && entry.turnId === interruptedTurnId) {
      interruptedTurnId = null
    }
    if (entry.type === 'consensus-task-start') {
      interruptedConsensusTaskId = entry.taskId
      interruptedConsensusBaseMessages = [...visibleMessages]
    }
    if (entry.type === 'consensus-task-end' && entry.taskId === interruptedConsensusTaskId) {
      if (entry.rollbackMessages) visibleMessages = [...entry.rollbackMessages]
      interruptedConsensusTaskId = null
      interruptedConsensusBaseMessages = null
    }
  }
  return { interruptedTurnId, interruptedConsensusTaskId, interruptedConsensusBaseMessages }
}

function deriveStatus(
  chain: SessionEntry[],
  interruptedTurnId: string | null,
  interruptedConsensusTaskId: string | null,
): 'idle' | 'max-turns' | 'interrupted' | 'error' {
  if (interruptedTurnId || interruptedConsensusTaskId) return 'interrupted'
  const lastEnd = [...chain]
    .reverse()
    .find((entry) => entry.type === 'turn-end' || entry.type === 'consensus-task-end')
  if (lastEnd?.type === 'turn-end') {
    if (lastEnd.stopReason === 'error') return 'error'
    return lastEnd.stopReason === 'max-turns' ? 'max-turns' : 'idle'
  }
  if (lastEnd?.type === 'consensus-task-end') {
    if (lastEnd.outcome === 'error') return 'error'
    return lastEnd.outcome === 'max-turns' ? 'max-turns' : 'idle'
  }
  return 'idle'
}

function userText(message: ModelMessage): string[] {
  if (message.role !== 'user') return []
  if (typeof message.content === 'string') return [message.content]
  return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : []))
}

function clip(text: string): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
}
