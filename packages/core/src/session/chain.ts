import type { ModelMessage } from 'ai'
import { keepsConsensusProgress } from '../consensus/types.ts'
import type { ActiveTaskPlan } from '../tasks/types.ts'
import { findPendingUserQuestion } from '../tasks/answer-resume.ts'
import {
  SESSION_SCHEMA_VERSION,
  sessionEntrySchema,
  type LoadedSession,
  type SessionEntry,
} from './types.ts'
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
  const undeliveredUserInputs = findUndeliveredUserInputs(chain)
  const undeliveredById = new Map(undeliveredUserInputs.map((input) => [input.id, input]))
  const work = findInterruptedWork(chain, undeliveredById)
  const messages = work.interruptedConsensusTaskId
    ? (work.interruptedConsensusBaseMessages ?? [])
    : collectMessages(chain, undeliveredById)
  const consensusState = collectConsensusState(chain)
  const turnStarts = collectTurnStarts(chain, undeliveredById)
  const activeTaskPlan = work.interruptedConsensusTaskId
    ? work.interruptedConsensusBaseTaskPlan
    : collectTaskPlan(chain)
  const viewEvents = collectViewEvents(entries)
  const pendingUserQuestion = findPendingUserQuestion(messages)
  if (
    pendingUserQuestion
    && pendingVisibleQuestionId(viewEvents) !== pendingUserQuestion.question.id
  ) {
    // 模型 step 已落盘、ViewTimeline 尚未来得及提交就崩溃时，从同一 step 的
    // 完整绑定恢复唯一可回答的问题卡，避免 UI 与模型事实源分裂。
    viewEvents.push({
      type: 'core-event',
      event: {
        type: 'user-question',
        question: structuredClone(pendingUserQuestion.question),
      },
    })
  }
  const modelId = collectModelId(chain, start.modelId)
  const {
    interruptedTurnId,
    interruptedConsensusTaskId,
    interruptedConsensusBaseMessages,
    interruptedConsensusBaseTurnIds,
  } = work
  const last = chain.at(-1)!
  const status = deriveStatus(
    chain,
    interruptedTurnId,
    interruptedConsensusTaskId,
    undeliveredUserInputs.length > 0,
    pendingUserQuestion !== null,
  )
  const recordedInputs = entries.flatMap((entry) => (entry.type === 'user-input' ? [entry.text] : []))
  const userTexts = recordedInputs.length > 0 ? recordedInputs : messages.flatMap(userText)

  return {
    entries,
    messages,
    viewEvents,
    turnStartMessages: turnStarts.messages,
    turnStartTaskPlans: turnStarts.taskPlans,
    leafUuid: last.uuid,
    interruptedTurnId,
    undeliveredUserInputIds: undeliveredUserInputs.map((input) => input.id),
    interruptedConsensusTaskId,
    interruptedConsensusBaseMessages,
    interruptedConsensusBaseTaskPlan: work.interruptedConsensusBaseTaskPlan,
    interruptedConsensusBaseTurnIds,
    consensusState,
    activeTaskPlan,
    metadata: {
      schemaVersion: SESSION_SCHEMA_VERSION,
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

function collectTurnStarts(
  chain: SessionEntry[],
  undeliveredById: ReadonlyMap<string, UndeliveredUserInput>,
): {
  messages: Map<string, ModelMessage[]>
  taskPlans: Map<string, ActiveTaskPlan | null>
} {
  const starts = new Map<string, ModelMessage[]>()
  const taskPlans = new Map<string, ActiveTaskPlan | null>()
  let messages: ModelMessage[] = []
  let taskPlan: ActiveTaskPlan | null = null
  let activeConsensusBaseMessages: ModelMessage[] | null = null
  let activeConsensusBaseTurnIds: Set<string> | null = null
  const partialTurnIds = new Set(
    [...undeliveredById.values()].flatMap((input) => input.partialTurnId ?? []),
  )
  for (const entry of chain) {
    if (entry.type === 'snapshot') {
      starts.clear()
      taskPlans.clear()
      messages = [...entry.messages]
      taskPlan = entry.taskPlan
      activeConsensusBaseMessages = entry.activeConsensusBaseMessages
        ? [...entry.activeConsensusBaseMessages]
        : null
      activeConsensusBaseTurnIds = entry.activeConsensusBaseTurnIds
        ? new Set(entry.activeConsensusBaseTurnIds)
        : null
      for (const start of entry.turnStartMessages) {
        starts.set(start.turnId, structuredClone(start.messages))
        taskPlans.set(start.turnId, structuredClone(start.taskPlan))
      }
    }
    if (entry.type === 'user-input' && undeliveredById.has(entry.uuid)) {
      const message: ModelMessage = { role: 'user', content: entry.text }
      messages.push(message)
      activeConsensusBaseMessages?.push(message)
    }
    if (entry.type === 'consensus-task-start') {
      activeConsensusBaseMessages = [
        ...messages,
        { role: 'user', content: entry.userText },
      ]
      activeConsensusBaseTurnIds = new Set(entry.baseTurnIds)
    }
    if (entry.type === 'turn-start' && !partialTurnIds.has(entry.turnId)) {
      starts.set(entry.turnId, structuredClone(messages))
      taskPlans.set(entry.turnId, structuredClone(taskPlan))
    }
    if (entry.type === 'messages') messages.push(...entry.messages)
    if (entry.type === 'task-state') taskPlan = entry.activePlan
    if (entry.type === 'consensus-task-end' && entry.rollbackMessages) {
      messages = consensusRollbackMessages(entry.rollbackMessages, activeConsensusBaseMessages)
      if (activeConsensusBaseTurnIds) {
        retainMapKeys(starts, activeConsensusBaseTurnIds)
        retainMapKeys(taskPlans, activeConsensusBaseTurnIds)
      }
    }
    if (entry.type === 'consensus-task-end') {
      taskPlan = entry.taskPlan
      activeConsensusBaseMessages = null
      activeConsensusBaseTurnIds = null
    }
  }
  if (activeConsensusBaseTurnIds) {
    retainMapKeys(starts, activeConsensusBaseTurnIds)
    retainMapKeys(taskPlans, activeConsensusBaseTurnIds)
  }
  return { messages: starts, taskPlans }
}

/** 可见时间线不随模型压缩换根；对话回滚由时间线中的 checkpoint-restored 事件重放。 */
function collectViewEvents(entries: SessionEntry[]): ViewEvent[] {
  return entries.flatMap((entry): ViewEvent[] => {
    if (entry.type === 'view-events') return entry.events
    if (entry.type === 'user-input' && entry.startsTurn) {
      return [{ type: 'user-message', text: entry.text, startsTurn: true }]
    }
    return []
  })
}

interface UndeliveredUserInput {
  id: string
  text: string
  partialTurnId: string | null
}

/** 根用户输入只有进入完整 messages 批次或共识起点后才算已交付给模型。 */
function findUndeliveredUserInputs(chain: SessionEntry[]): UndeliveredUserInput[] {
  const childByParent = new Map<string, SessionEntry>()
  for (const entry of chain) {
    if (entry.parentUuid) childByParent.set(entry.parentUuid, entry)
  }

  return chain.flatMap((entry): UndeliveredUserInput[] => {
    if (entry.type !== 'user-input' || !entry.startsTurn) return []
    const delivery = childByParent.get(entry.uuid)
    if (delivery?.type === 'consensus-task-start') return []
    if (delivery?.type === 'turn-start') {
      const batch = childByParent.get(delivery.uuid)
      if (batch?.type === 'messages' && batch.turnId === delivery.turnId) return []
      return [{ id: entry.uuid, text: entry.text, partialTurnId: delivery.turnId }]
    }
    return [{ id: entry.uuid, text: entry.text, partialTurnId: null }]
  })
}

function pendingVisibleQuestionId(events: ViewEvent[]): string | null {
  let pendingQuestionId: string | null = null
  for (const entry of events) {
    if (entry.type === 'user-message') {
      pendingQuestionId = null
      continue
    }
    const event = entry.event
    if (event.type === 'user-question') pendingQuestionId = event.question.id
    if (
      event.type === 'checkpoint-restored'
      && event.ok
      && event.scope === 'files-and-chat'
    ) {
      pendingQuestionId = event.question?.id ?? null
    }
  }
  return pendingQuestionId
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
      const hasBaseTurnIds = entry.activeConsensusBaseTurnIds !== null
      if (
        hasTask !== hasBase
        || hasTask !== hasBaseTurnIds
        || (hasTask && entry.consensusState === null)
      ) {
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

function collectMessages(
  chain: SessionEntry[],
  undeliveredById: ReadonlyMap<string, UndeliveredUserInput>,
): ModelMessage[] {
  let messages: ModelMessage[] = []
  let activeConsensusBaseMessages: ModelMessage[] | null = null
  for (const entry of chain) {
    if (entry.type === 'snapshot') {
      messages = [...entry.messages]
      activeConsensusBaseMessages = entry.activeConsensusBaseMessages
        ? [...entry.activeConsensusBaseMessages]
        : null
    }
    if (entry.type === 'user-input' && undeliveredById.has(entry.uuid)) {
      const message: ModelMessage = { role: 'user', content: entry.text }
      messages.push(message)
      activeConsensusBaseMessages?.push(message)
    }
    if (entry.type === 'consensus-task-start') {
      activeConsensusBaseMessages = [
        ...messages,
        { role: 'user', content: entry.userText },
      ]
    }
    if (entry.type === 'messages') messages.push(...entry.messages)
    if (entry.type === 'consensus-task-end' && entry.rollbackMessages) {
      messages = consensusRollbackMessages(entry.rollbackMessages, activeConsensusBaseMessages)
    }
    if (entry.type === 'consensus-task-end') activeConsensusBaseMessages = null
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

function collectTaskPlan(chain: SessionEntry[]): ActiveTaskPlan | null {
  let plan: ActiveTaskPlan | null = null
  for (const entry of chain) {
    if (entry.type === 'snapshot') plan = entry.taskPlan
    if (entry.type === 'task-state') plan = entry.activePlan
    if (entry.type === 'consensus-task-end') plan = entry.taskPlan
  }
  return plan
}

function collectModelId(chain: SessionEntry[], initialModelId: string): string {
  let modelId = initialModelId
  for (const entry of chain) {
    if (entry.type === 'snapshot' || entry.type === 'model-change') modelId = entry.modelId
  }
  return modelId
}

function findInterruptedWork(
  chain: SessionEntry[],
  undeliveredById: ReadonlyMap<string, UndeliveredUserInput>,
): {
  interruptedTurnId: string | null
  interruptedConsensusTaskId: string | null
  interruptedConsensusBaseMessages: ModelMessage[] | null
  interruptedConsensusBaseTaskPlan: ActiveTaskPlan | null
  interruptedConsensusBaseTurnIds: string[] | null
} {
  let interruptedTurnId: string | null = null
  let interruptedConsensusTaskId: string | null = null
  let interruptedConsensusBaseMessages: ModelMessage[] | null = null
  let interruptedConsensusBaseTaskPlan: ActiveTaskPlan | null = null
  let interruptedConsensusBaseTurnIds: string[] | null = null
  let visibleMessages: ModelMessage[] = []
  for (const entry of chain) {
    if (entry.type === 'snapshot') {
      visibleMessages = structuredClone(entry.messages)
      interruptedTurnId = entry.activeTurnId
      interruptedConsensusTaskId = entry.activeConsensusTaskId
      // 重放是纯读取：后续遇到未交付输入时会向工作副本 push，绝不能污染已解析快照。
      interruptedConsensusBaseMessages = structuredClone(entry.activeConsensusBaseMessages)
      interruptedConsensusBaseTaskPlan = structuredClone(entry.activeConsensusBaseTaskPlan)
      interruptedConsensusBaseTurnIds = structuredClone(entry.activeConsensusBaseTurnIds)
    }
    if (entry.type === 'user-input' && undeliveredById.has(entry.uuid)) {
      const message: ModelMessage = { role: 'user', content: entry.text }
      visibleMessages.push(message)
      interruptedConsensusBaseMessages?.push(message)
    }
    if (entry.type === 'messages') visibleMessages.push(...entry.messages)
    if (entry.type === 'turn-start') interruptedTurnId = entry.turnId
    if (entry.type === 'turn-end' && entry.turnId === interruptedTurnId) {
      interruptedTurnId = null
    }
    if (entry.type === 'consensus-task-start') {
      interruptedConsensusTaskId = entry.taskId
      interruptedConsensusBaseMessages = [
        ...visibleMessages,
        { role: 'user', content: entry.userText },
      ]
      interruptedConsensusBaseTaskPlan = structuredClone(entry.baseTaskPlan)
      interruptedConsensusBaseTurnIds = [...entry.baseTurnIds]
    }
    if (entry.type === 'consensus-task-end' && entry.taskId === interruptedConsensusTaskId) {
      if (entry.rollbackMessages) {
        visibleMessages = consensusRollbackMessages(
          entry.rollbackMessages,
          interruptedConsensusBaseMessages,
        )
      }
      interruptedConsensusTaskId = null
      interruptedConsensusBaseMessages = null
      interruptedConsensusBaseTaskPlan = null
      interruptedConsensusBaseTurnIds = null
    }
  }
  return {
    interruptedTurnId,
    interruptedConsensusTaskId,
    interruptedConsensusBaseMessages,
    interruptedConsensusBaseTaskPlan,
    interruptedConsensusBaseTurnIds,
  }
}

function consensusRollbackMessages(
  persistedMessages: ModelMessage[],
  effectiveBaseMessages: ModelMessage[] | null,
): ModelMessage[] {
  if (!effectiveBaseMessages || persistedMessages.length === 0) return [...persistedMessages]
  return [...effectiveBaseMessages, persistedMessages.at(-1)!]
}

function retainMapKeys<T>(map: Map<string, T>, allowedKeys: ReadonlySet<string>): void {
  for (const key of map.keys()) {
    if (!allowedKeys.has(key)) map.delete(key)
  }
}

function deriveStatus(
  chain: SessionEntry[],
  interruptedTurnId: string | null,
  interruptedConsensusTaskId: string | null,
  hasUndeliveredUserInput: boolean,
  hasPendingUserQuestion: boolean,
): 'idle' | 'waiting-user' | 'paused' | 'max-turns' | 'interrupted' | 'error' {
  if (interruptedTurnId || interruptedConsensusTaskId || hasUndeliveredUserInput) {
    return 'interrupted'
  }
  if (hasPendingUserQuestion) return 'waiting-user'
  const lastEnd = [...chain]
    .reverse()
    .find((entry) => entry.type === 'turn-end' || entry.type === 'consensus-task-end')
  if (lastEnd?.type === 'turn-end') {
    if (lastEnd.stopReason === 'error') return 'error'
    if (lastEnd.stopReason === 'waiting-user') return 'waiting-user'
    if (lastEnd.stopReason === 'paused') return 'paused'
    return lastEnd.stopReason === 'max-turns' ? 'max-turns' : 'idle'
  }
  if (lastEnd?.type === 'consensus-task-end') {
    if (lastEnd.outcome === 'error') return 'error'
    if (lastEnd.outcome === 'paused') return 'paused'
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
