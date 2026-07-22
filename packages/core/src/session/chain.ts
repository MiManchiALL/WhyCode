import type { ModelMessage } from 'ai'
import { keepsConsensusProgress } from '../consensus/types.ts'
import { cloneTaskPlanState, emptyTaskPlanState, type TaskPlanState } from '../tasks/types.ts'
import { findPendingUserQuestion } from '../tasks/answer-resume.ts'
import {
  SESSION_SCHEMA_VERSION,
  sessionEntrySchema,
  type LoadedSession,
  type PendingUserInput,
  type SessionEntry,
} from './types.ts'
import type { ViewEvent } from './view-events.ts'
import { createImageUserMessage } from '../attachments/messages.ts'
import type { ImageAttachment } from '../attachments/types.ts'
import { withPdfAttachmentReferences } from '../pdf/messages.ts'
import type { PdfAttachment } from '../pdf/types.ts'
import type { ReasoningEffortSelection } from '../providers/catalog.ts'

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
  const pendingUserInputs = collectPendingUserInputs(chain)
  const undeliveredUserInputs = findUndeliveredUserInputs(chain)
  const undeliveredById = new Map(undeliveredUserInputs.map((input) => [input.id, input]))
  const work = findInterruptedWork(chain, undeliveredById)
  const messages = work.interruptedConsensusTaskId
    ? (work.interruptedConsensusBaseMessages ?? [])
    : collectMessages(chain, undeliveredById)
  const consensusState = collectConsensusState(chain)
  const turnStarts = collectTurnStarts(chain, undeliveredById)
  const taskState = work.interruptedConsensusTaskId
    ? work.interruptedConsensusBaseTaskState ?? emptyTaskPlanState()
    : collectTaskState(chain)
  const viewEvents = collectViewEvents(entries)
  const imageAttachments = collectImageAttachments(entries)
  const pdfAttachments = collectPdfAttachments(entries)
  reconcileTaskPlanView(viewEvents, taskState)
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
  const modelSelection = collectModelSelection(
    chain,
    start.modelId,
    start.reasoningEffort ?? 'default',
  )
  const {
    interruptedTurnId,
    interruptedTurnEngagedPlanId,
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
    pendingUserInputs.some((input) => input.state === 'queued'),
    pendingUserQuestion !== null,
  )
  const recordedInputs = entries.flatMap((entry) => (entry.type === 'user-input' ? [entry.text] : []))
  const userTexts = recordedInputs.length > 0 ? recordedInputs : messages.flatMap(userText)

  return {
    entries,
    messages,
    viewEvents,
    imageAttachments,
    pdfAttachments,
    turnStartMessages: turnStarts.messages,
    turnStartTaskStates: turnStarts.taskStates,
    leafUuid: last.uuid,
    interruptedTurnId,
    interruptedTurnEngagedPlanId,
    undeliveredUserInputIds: undeliveredUserInputs.map((input) => input.id),
    pendingUserInputs,
    interruptedConsensusTaskId,
    interruptedConsensusBaseMessages,
    interruptedConsensusBaseTaskState: work.interruptedConsensusBaseTaskState,
    interruptedConsensusBaseTurnIds,
    consensusState,
    taskState,
    metadata: {
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId: start.sessionId,
      projectDir: start.projectDir,
      modelId: modelSelection.modelId,
      reasoningEffort: modelSelection.reasoningEffort,
      title: clip(userTexts[0] ?? ''),
      lastUserText: clip(userTexts.at(-1) ?? ''),
      createdAt: start.timestamp,
      updatedAt: last.timestamp,
      status,
    },
  }
}

function collectImageAttachments(entries: SessionEntry[]): ImageAttachment[] {
  const attachments = new Map<string, { serialized: string; value: ImageAttachment }>()
  for (const entry of entries) {
    const values = entry.type === 'user-input' || entry.type === 'messages'
      ? entry.attachments ?? []
      : entry.type === 'snapshot'
        ? entry.pendingUserInputs.flatMap((input) => input.attachments ?? [])
        : []
    for (const value of values) {
      const serialized = JSON.stringify(value)
      const previous = attachments.get(value.storageName)
      if (previous && previous.serialized !== serialized) {
        throw new SessionCorruptError(`图片附件元数据冲突：${value.storageName}`)
      }
      if (!previous) attachments.set(value.storageName, { serialized, value })
    }
  }
  return [...attachments.values()].map(({ value }) => value)
}

function collectPdfAttachments(entries: SessionEntry[]): PdfAttachment[] {
  const attachments = new Map<string, { serialized: string; value: PdfAttachment }>()
  for (const entry of entries) {
    const values = entry.type === 'user-input' || entry.type === 'messages'
      ? entry.pdfAttachments ?? []
      : entry.type === 'snapshot'
        ? entry.pendingUserInputs.flatMap((input) => input.pdfAttachments ?? [])
        : []
    for (const value of values) {
      const serialized = JSON.stringify(value)
      const previous = attachments.get(value.storageName)
      if (previous && previous.serialized !== serialized) {
        throw new SessionCorruptError(`PDF 附件元数据冲突：${value.storageName}`)
      }
      if (!previous) attachments.set(value.storageName, { serialized, value })
    }
  }
  return [...attachments.values()].map(({ value }) => value)
}

/**
 * steering 身份随 JSONL 父链重放；送达确认与模型消息同条提交，崩溃只会落在
 * “仍排队”一侧，不会出现模型已消费但事实源仍把它重复恢复的分裂状态。
 */
function collectPendingUserInputs(chain: SessionEntry[]): PendingUserInput[] {
  const pending = new Map<string, PendingUserInput>()

  for (const entry of chain) {
    if (entry.type === 'snapshot') {
      pending.clear()
      for (const input of entry.pendingUserInputs) {
        if (pending.has(input.id)) {
          throw new SessionCorruptError(`snapshot 包含重复待处理输入：${input.id}`)
        }
        pending.set(input.id, structuredClone(input))
      }
      continue
    }

    if (entry.type === 'user-input') {
      consumeRestoredInputs(pending, entry.consumesInputIds ?? [])
      if (!entry.startsTurn) {
        if (pending.has(entry.uuid)) {
          throw new SessionCorruptError(`待处理输入 ID 重复：${entry.uuid}`)
        }
        pending.set(entry.uuid, {
          id: entry.uuid,
          text: entry.text,
          ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
          ...(entry.pdfAttachments?.length ? { pdfAttachments: entry.pdfAttachments } : {}),
          state: 'queued',
        })
      }
      continue
    }

    if (entry.type === 'user-input-restored') {
      for (const inputId of entry.inputIds) {
        const input = pending.get(inputId)
        if (!input || input.state !== 'queued') {
          throw new SessionCorruptError(`只能退回仍在排队的输入：${inputId}`)
        }
        pending.set(inputId, { ...input, state: 'restored' })
      }
      continue
    }

    if (entry.type === 'messages' || entry.type === 'consensus-task-start') {
      deliverQueuedInputs(pending, entry.deliveredInputIds ?? [])
    }
  }

  return [...pending.values()].map((input) => structuredClone(input))
}

function consumeRestoredInputs(
  pending: Map<string, PendingUserInput>,
  inputIds: readonly string[],
): void {
  for (const inputId of inputIds) {
    const input = pending.get(inputId)
    if (!input || input.state !== 'restored') {
      throw new SessionCorruptError(`只能消费已恢复到草稿的输入：${inputId}`)
    }
    pending.delete(inputId)
  }
}

function deliverQueuedInputs(
  pending: Map<string, PendingUserInput>,
  inputIds: readonly string[],
): void {
  for (const inputId of inputIds) {
    const input = pending.get(inputId)
    if (!input || input.state !== 'queued') {
      throw new SessionCorruptError(`只能确认送达仍在排队的输入：${inputId}`)
    }
    pending.delete(inputId)
  }
}

function collectTurnStarts(
  chain: SessionEntry[],
  undeliveredById: ReadonlyMap<string, UndeliveredUserInput>,
): {
  messages: Map<string, ModelMessage[]>
  taskStates: Map<string, TaskPlanState>
} {
  const starts = new Map<string, ModelMessage[]>()
  const taskStates = new Map<string, TaskPlanState>()
  let messages: ModelMessage[] = []
  let taskState = emptyTaskPlanState()
  let activeConsensusBaseMessages: ModelMessage[] | null = null
  let activeConsensusBaseTurnIds: Set<string> | null = null
  const partialTurnIds = new Set(
    [...undeliveredById.values()].flatMap((input) => input.partialTurnId ?? []),
  )
  for (const entry of chain) {
    if (entry.type === 'snapshot') {
      starts.clear()
      taskStates.clear()
      messages = [...entry.messages]
      taskState = cloneTaskPlanState(entry.taskState)
      activeConsensusBaseMessages = entry.activeConsensusBaseMessages
        ? [...entry.activeConsensusBaseMessages]
        : null
      activeConsensusBaseTurnIds = entry.activeConsensusBaseTurnIds
        ? new Set(entry.activeConsensusBaseTurnIds)
        : null
      for (const start of entry.turnStartMessages) {
        starts.set(start.turnId, structuredClone(start.messages))
        taskStates.set(start.turnId, cloneTaskPlanState(start.taskState))
      }
    }
    if (entry.type === 'user-input' && undeliveredById.has(entry.uuid)) {
      const message = userInputMessage(entry.text, entry.attachments, entry.pdfAttachments)
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
      taskStates.set(entry.turnId, cloneTaskPlanState(taskState))
    }
    if (entry.type === 'messages') {
      messages.push(...entry.messages)
      if (entry.taskState) taskState = cloneTaskPlanState(entry.taskState)
    }
    if (entry.type === 'consensus-task-end' && entry.rollbackMessages) {
      messages = consensusRollbackMessages(entry.rollbackMessages, activeConsensusBaseMessages)
      if (activeConsensusBaseTurnIds) {
        retainMapKeys(starts, activeConsensusBaseTurnIds)
        retainMapKeys(taskStates, activeConsensusBaseTurnIds)
      }
    }
    if (entry.type === 'consensus-task-end') {
      taskState = cloneTaskPlanState(entry.taskState)
      activeConsensusBaseMessages = null
      activeConsensusBaseTurnIds = null
    }
  }
  if (activeConsensusBaseTurnIds) {
    retainMapKeys(starts, activeConsensusBaseTurnIds)
    retainMapKeys(taskStates, activeConsensusBaseTurnIds)
  }
  return { messages: starts, taskStates }
}

/** 可见时间线不随模型压缩换根；对话回滚由时间线中的 checkpoint-restored 事件重放。 */
function collectViewEvents(entries: SessionEntry[]): ViewEvent[] {
  const events: ViewEvent[] = []
  const inputs = new Map<string, Extract<SessionEntry, { type: 'user-input' }>>()
  const visibleInputIds = new Set(entries.flatMap((entry) =>
    entry.type === 'view-events'
      ? entry.events.flatMap((event) =>
          event.type === 'user-message' && event.inputId ? [event.inputId] : [])
      : []))

  for (const entry of entries) {
    if (entry.type === 'view-events') {
      events.push(...entry.events)
      continue
    }
    if (entry.type === 'user-input') inputs.set(entry.uuid, entry)
    if (entry.type === 'user-input' && entry.startsTurn) {
      events.push({
        type: 'user-message',
        text: entry.text,
        startsTurn: true,
        ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
        ...(entry.pdfAttachments?.length ? { pdfAttachments: entry.pdfAttachments } : {}),
      })
    }
    if (entry.type === 'messages' || entry.type === 'consensus-task-start') {
      for (const inputId of entry.deliveredInputIds ?? []) {
        if (visibleInputIds.has(inputId)) continue
        const input = inputs.get(inputId)
        if (!input || input.startsTurn) continue
        events.push({
          type: 'user-message',
          inputId,
          text: input.text,
          startsTurn: false,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          ...(input.pdfAttachments?.length ? { pdfAttachments: input.pdfAttachments } : {}),
        })
        visibleInputIds.add(inputId)
      }
    }
  }
  return events
}

interface UndeliveredUserInput {
  id: string
  text: string
  attachments: ImageAttachment[]
  pdfAttachments: PdfAttachment[]
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
      return [{
        id: entry.uuid,
        text: entry.text,
        attachments: entry.attachments ?? [],
        pdfAttachments: entry.pdfAttachments ?? [],
        partialTurnId: delivery.turnId,
      }]
    }
    return [{
      id: entry.uuid,
      text: entry.text,
      attachments: entry.attachments ?? [],
      pdfAttachments: entry.pdfAttachments ?? [],
      partialTurnId: null,
    }]
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
      const message = userInputMessage(entry.text, entry.attachments, entry.pdfAttachments)
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

function collectTaskState(chain: SessionEntry[]): TaskPlanState {
  let state = emptyTaskPlanState()
  for (const entry of chain) {
    if (entry.type === 'snapshot') state = cloneTaskPlanState(entry.taskState)
    if (entry.type === 'messages' && entry.taskState) {
      state = cloneTaskPlanState(entry.taskState)
    }
    if (entry.type === 'consensus-task-end') state = cloneTaskPlanState(entry.taskState)
  }
  return state
}

function reconcileTaskPlanView(
  viewEvents: ViewEvent[],
  taskState: TaskPlanState,
): void {
  const visible = latestVisibleTaskPlan(viewEvents)
  const active = taskState.activePlan
  if (active) {
    if (visible?.kind === 'active' && visible.id === active.id && visible.revision === active.revision) {
      return
    }
    viewEvents.push({
      type: 'core-event',
      event: { type: 'task-plan-restored', plan: structuredClone(active) },
    })
    return
  }
  if (!visible || visible.kind === 'none') return
  const latestHistory = taskState.historicalPlans.at(-1)
  if (
    visible.kind === 'terminal'
    && visible.id === latestHistory?.id
    && visible.revision === latestHistory.revision
  ) return
  viewEvents.push({
    type: 'core-event',
    event: { type: 'task-plan-restored', plan: null },
  })
}

function latestVisibleTaskPlan(
  viewEvents: ViewEvent[],
): { kind: 'none' } | { kind: 'active' | 'terminal'; id: string; revision: number } | null {
  for (let index = viewEvents.length - 1; index >= 0; index--) {
    const entry = viewEvents[index]
    if (entry?.type !== 'core-event') continue
    const event = entry.event
    if (event.type === 'task-plan-replaced') {
      return { kind: 'active', id: event.plan.id, revision: event.plan.revision }
    }
    if (event.type === 'task-plan-updated') {
      return {
        kind: event.plan.status === 'active' ? 'active' : 'terminal',
        id: event.plan.id,
        revision: event.plan.revision,
      }
    }
    if (event.type === 'task-plan-restored') {
      if (!event.plan) return { kind: 'none' }
      return {
        kind: event.plan.status === 'active' ? 'active' : 'terminal',
        id: event.plan.id,
        revision: event.plan.revision,
      }
    }
  }
  return null
}

function collectModelSelection(
  chain: SessionEntry[],
  initialModelId: string,
  initialReasoningEffort: ReasoningEffortSelection,
): { modelId: string; reasoningEffort: ReasoningEffortSelection } {
  let modelId = initialModelId
  let reasoningEffort = initialReasoningEffort
  for (const entry of chain) {
    if (entry.type === 'snapshot' || entry.type === 'model-change') {
      modelId = entry.modelId
      reasoningEffort = entry.reasoningEffort ?? 'default'
    }
  }
  return { modelId, reasoningEffort }
}

function findInterruptedWork(
  chain: SessionEntry[],
  undeliveredById: ReadonlyMap<string, UndeliveredUserInput>,
): {
  interruptedTurnId: string | null
  interruptedTurnEngagedPlanId: string | null
  interruptedConsensusTaskId: string | null
  interruptedConsensusBaseMessages: ModelMessage[] | null
  interruptedConsensusBaseTaskState: TaskPlanState | null
  interruptedConsensusBaseTurnIds: string[] | null
} {
  let interruptedTurnId: string | null = null
  let interruptedTurnEngagedPlanId: string | null = null
  let interruptedConsensusTaskId: string | null = null
  let interruptedConsensusBaseMessages: ModelMessage[] | null = null
  let interruptedConsensusBaseTaskState: TaskPlanState | null = null
  let interruptedConsensusBaseTurnIds: string[] | null = null
  let visibleMessages: ModelMessage[] = []
  for (const entry of chain) {
    if (entry.type === 'snapshot') {
      visibleMessages = structuredClone(entry.messages)
      interruptedTurnId = entry.activeTurnId
      interruptedTurnEngagedPlanId = entry.activeTurnEngagedPlanId
      interruptedConsensusTaskId = entry.activeConsensusTaskId
      // 重放是纯读取：后续遇到未交付输入时会向工作副本 push，绝不能污染已解析快照。
      interruptedConsensusBaseMessages = structuredClone(entry.activeConsensusBaseMessages)
      interruptedConsensusBaseTaskState = structuredClone(entry.activeConsensusBaseTaskState)
      interruptedConsensusBaseTurnIds = structuredClone(entry.activeConsensusBaseTurnIds)
    }
    if (entry.type === 'user-input' && undeliveredById.has(entry.uuid)) {
      const message = userInputMessage(entry.text, entry.attachments, entry.pdfAttachments)
      visibleMessages.push(message)
      interruptedConsensusBaseMessages?.push(message)
    }
    if (entry.type === 'messages') {
      visibleMessages.push(...entry.messages)
      if (entry.turnId === interruptedTurnId && entry.engagedPlanId !== undefined) {
        interruptedTurnEngagedPlanId = entry.engagedPlanId
      }
    }
    if (entry.type === 'turn-start') {
      interruptedTurnId = entry.turnId
      interruptedTurnEngagedPlanId = entry.engagedPlanId
    }
    if (entry.type === 'turn-end' && entry.turnId === interruptedTurnId) {
      interruptedTurnId = null
      interruptedTurnEngagedPlanId = null
    }
    if (entry.type === 'consensus-task-start') {
      interruptedConsensusTaskId = entry.taskId
      interruptedConsensusBaseMessages = [
        ...visibleMessages,
        { role: 'user', content: entry.userText },
      ]
      interruptedConsensusBaseTaskState = cloneTaskPlanState(entry.baseTaskState)
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
      interruptedConsensusBaseTaskState = null
      interruptedConsensusBaseTurnIds = null
    }
  }
  return {
    interruptedTurnId,
    interruptedTurnEngagedPlanId,
    interruptedConsensusTaskId,
    interruptedConsensusBaseMessages,
    interruptedConsensusBaseTaskState,
    interruptedConsensusBaseTurnIds,
  }
}

function userInputMessage(
  text: string,
  attachments: readonly ImageAttachment[] | undefined,
  pdfAttachments: readonly PdfAttachment[] | undefined,
): ModelMessage {
  const content = withPdfAttachmentReferences(text, pdfAttachments ?? [])
  return attachments?.length
    ? createImageUserMessage(content, attachments)
    : { role: 'user', content }
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
  hasQueuedUserInput: boolean,
  hasPendingUserQuestion: boolean,
): 'idle' | 'waiting-user' | 'paused' | 'max-turns' | 'interrupted' | 'error' {
  if (
    interruptedTurnId
    || interruptedConsensusTaskId
    || hasUndeliveredUserInput
    || hasQueuedUserInput
  ) {
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
