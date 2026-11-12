import type {
  BtwMode,
  ImageAttachment,
  PdfAttachment,
  SkillSummary,
  TaskPlan,
  ViewEvent,
} from '@whycode/core'
import {
  appendVisibleToolOutput, questionsForBatch,
  isStepScopedCoreEvent,
  visibleToolResult,
  type CoreEvent,
  type ToolFileChange,
  type PendingQuestion,
  type QuestionReply,
} from '@whycode/core/events'
import type { RuntimeSnapshot } from './session.ts'
import { summarizeToolCall } from './tool-call-summary.ts'

export interface ToolCall {
  id: string
  name: string
  input: unknown
  status: 'running' | 'done' | 'error'
  result?: string
  questionAnswers?: Record<string, string | null>
  progress: string
  /** 文件写入工具实际落盘后的逐文件增删行统计。 */
  fileChanges?: ToolFileChange[]
  /** 有持久化资源检查点；切换会话或重启后仍可回滚。 */
  hasCheckpoint?: boolean
  /** 完整检查点的稳定标识；回滚后仍可读取当时版本与净改动。 */
  checkpointId?: string
  /** ReadFile 复制进当前会话的稳定图片元数据。 */
  attachments?: ImageAttachment[]
}

export interface PeerBlockData {
  agentId: 'B' | 'C'
  status: 'working' | 'done'
  text: string
  tools: { id: string; name: string; summary: string; isError: boolean }[]
  vote?: { vote: string; reason: string; suggestedChange?: string }
}

export type CandidateBlockData = Omit<
  Extract<CoreEvent, { type: 'candidate-submitted' }>,
  'type'
>

export type Block =
  | {
      kind: 'user'
      id: string
      inputId?: string
      turnId?: string
      startsTurn?: true
      timestamp?: string
      text: string
      attachments?: ImageAttachment[]
      pdfAttachments?: PdfAttachment[]
      skills?: SkillSummary[]
      btw?: { conversationId: string; turnIndex: number; mode: BtwMode }
    }
  | {
      kind: 'text'
      id: string
      text: string
      /**
       * pending 为流式草稿，response 为已提交的无工具回复。只有回合确认完成
       * 才转为 final；继续执行、等待后停止及工具步骤的正文都属于 activity。
       */
      phase: 'pending' | 'response' | 'activity' | 'final'
      textBlock?: number
      timestamp?: string
    }
  | { kind: 'thinking'; id: string; text: string; durationMs: number | null }
  | {
      kind: 'work-duration'
      id: string
      forkTurnId: string | null
      durationMs: number
      outcome: 'completed' | 'stopped' | 'error'
      error?: string
    }
  | { kind: 'model-request-retry'; id: string; retry: number; maxRetries: number; message: string }
  | { kind: 'compaction'; id: string; index: number; status: Extract<CoreEvent, { type: 'context-compaction' }>['status'] }
  | { kind: 'compaction'; id: string; index: number; status: 'completed'; preTokens: number; postTokens: number }
  | { kind: 'tool'; id: string; call: ToolCall }
  | { kind: 'candidate'; id: string; candidate: CandidateBlockData }
  | { kind: 'peer'; id: string; peer: PeerBlockData }

interface PendingStepSnapshot {
  blocks: Block[]
  nextId: number
  taskPlan: TaskPlan | null
  fileRollbackBoundaryTurnId: string | null
}

export interface ConversationState {
  blocks: Block[]
  expanded: Set<string>
  nextId: number
  /** 完整压缩事件的单调序号；分页和回滚不能使历史摘要定位发生变化。 */
  compactionCount: number
  pendingTurnStart: number | null
  turnStartBlocks: Map<string, number>
  /** 当前/最近一个结构化计划；独立于聊天块，避免频繁进度更新刷屏。 */
  taskPlan: TaskPlan | null
  /** 最近一个尚未被用户消息回答的问题；由可见事件重放恢复。 */
  pendingQuestions: PendingQuestion[]
  /** 工具批次的可见步骤可能晚于已经持久化的问答。 */
  questionAnswersBeforeTool: Record<string, Record<string, string | null>>
  /** 最近一次仅文件回滚的 turn 边界；后续首次成功文件修改会清除。 */
  fileRollbackBoundaryTurnId: string | null
  /** 当前会话文件状态发生确定变化的单调版本；只用于刷新活动文件预览。 */
  fileSystemRevision: number
  /** 实时模型步骤开始前的稳定界面；提交时清除，丢弃时原样恢复。 */
  pendingStep: PendingStepSnapshot | null
  /** 仅表示下一条 BBTW 是否可用；完整侧历史由主进程事实源持有。 */
  btwContinuation: { conversationId: string; turnIndex: number } | null
  pendingBtw: { conversationId: string; turnIndex: number; mode: BtwMode } | null
}

const VOTE_LABELS: Record<string, string> = {
  accept: '✅ 接受',
  accept_with_minor_edits: '☑️ 接受（小修改）',
  reject: '❌ 拒绝',
}

export function voteLabel(vote: string): string {
  return VOTE_LABELS[vote] ?? vote
}

export function createConversationState(
  events: readonly ViewEvent[] = [],
  timestamps: readonly string[] = [],
  committedEventCount = events.length,
): ConversationState {
  let state: ConversationState = {
    blocks: [],
    expanded: new Set(),
    nextId: 0,
    compactionCount: 0,
    pendingTurnStart: null,
    turnStartBlocks: new Map(),
    taskPlan: null,
    pendingQuestions: [],
    questionAnswersBeforeTool: {},
    fileRollbackBoundaryTurnId: null,
    fileSystemRevision: 0,
    pendingStep: null,
    btwContinuation: null,
    pendingBtw: null,
  }
  for (const [index, event] of events.entries()) {
    state = index >= committedEventCount && event.type === 'core-event'
      ? applyCoreEvent(state, event.event, timestamps[index])
      : applyViewEvent(state, event, timestamps[index])
  }
  return state
}

/**
 * 回滚的事务边界是整轮对话；每个工具检查点仍保留为恢复引擎的精确事实，
 * 但界面只把该轮最早的有效检查点投影为入口，避免让用户误以为按钮只影响单个工具。
 */
export function checkpointRestoreAnchorIds(
  state: Pick<ConversationState, 'blocks' | 'turnStartBlocks'>,
): ReadonlySet<string> {
  const anchors = new Set<string>()
  const starts = [...new Set(state.turnStartBlocks.values())].sort((left, right) => left - right)
  for (let turnIndex = 0; turnIndex < starts.length; turnIndex++) {
    const start = starts[turnIndex]!
    const end = starts[turnIndex + 1] ?? state.blocks.length
    for (let blockIndex = start; blockIndex < end; blockIndex++) {
      const block = state.blocks[blockIndex]
      if (block?.kind !== 'tool' || !block.call.hasCheckpoint) continue
      anchors.add(block.call.id)
      break
    }
  }
  return anchors
}

export function runtimeEventsAfterSnapshot<T extends { runtimeId: string; sequence: number }>(
  buffered: readonly T[],
  snapshot: Pick<RuntimeSnapshot, 'runtimeId' | 'eventSequence'>,
): T[] {
  return buffered.filter((entry) =>
    entry.runtimeId !== snapshot.runtimeId || entry.sequence > snapshot.eventSequence)
}

export function resumeTargetCommitted(
  snapshot: Pick<RuntimeSnapshot, 'resumingSessionId' | 'sessionId'>,
  targetSessionId: string,
): boolean {
  return snapshot.resumingSessionId === null && snapshot.sessionId === targetSessionId
}

export function applyViewEvent(
  state: ConversationState,
  event: ViewEvent,
  timestamp?: string,
): ConversationState {
  if (event.type === 'step-committed') {
    return { ...state, blocks: commitResponseText(state.blocks, event.hasToolCalls) }
  }
  if (event.type === 'pending-questions') return resetPendingQuestions(state, event.questions)
  if (event.type === 'turn-completed') return confirmTurnResponse(state)
  return event.type === 'user-message'
    ? appendUserMessage(
        state,
        event.text,
        event.startsTurn,
        event.attachments,
        event.pdfAttachments,
        event.skills,
        event.inputId,
        timestamp,
        event.btw,
      )
    : applyStableCoreEvent(state, event.event, timestamp)
}

export function applyCoreEvent(
  state: ConversationState,
  event: CoreEvent,
  timestamp?: string,
): ConversationState {
  if (event.type === 'step-committed') {
    return commitPendingStep(state)
  }
  if (event.type === 'step-output-retained') return retainStepOutput(state)
  if (event.type === 'step-discarded') {
    return state.pendingStep
      ? { ...state, ...state.pendingStep, pendingStep: null }
      : state
  }
  const current = isStepScopedCoreEvent(event) && !state.pendingStep
    ? beginPendingStep(state)
    : state
  return applyStableCoreEvent(current, event, timestamp)
}

function applyStableCoreEvent(
  state: ConversationState,
  event: CoreEvent,
  timestamp?: string,
): ConversationState {
  switch (event.type) {
    case 'turn-end':
      return event.stopReason === 'completed' || event.stopReason === 'waiting-user' ? confirmTurnResponse(state) : state
    case 'turn-start': {
      state = continueWork(state)
      if (state.pendingTurnStart === null) return state
      const turnStartBlocks = new Map(state.turnStartBlocks)
      turnStartBlocks.set(event.turnId, state.pendingTurnStart)
      const blocks = [...state.blocks]
      const root = blocks[state.pendingTurnStart]
      if (root?.kind === 'user') blocks[state.pendingTurnStart] = { ...root, turnId: event.turnId }
      return {
        ...state,
        blocks,
        pendingTurnStart: null,
        turnStartBlocks,
      }
    }
    case 'user-message-edited':
      return applyUserMessageEdited(state, event, timestamp)
    case 'message-injected':
      return appendUserMessage(
        state,
        event.text,
        event.startsTurn ?? false,
        event.attachments,
        event.pdfAttachments,
        event.skills,
        event.id,
        timestamp,
      )
    case 'user-message-accepted':
      return appendUserMessage(
        state,
        event.text,
        event.startsTurn,
        event.attachments,
        event.pdfAttachments,
        event.skills,
        event.inputId,
        timestamp,
      )
    case 'btw-message-accepted':
      return appendUserMessage(
        state,
        event.text,
        false,
        event.attachments,
        [],
        [],
        event.inputId,
        timestamp,
        event.btw,
      )
    case 'btw-message-edited':
      return applyBtwMessageEdited(state, event, timestamp)
    case 'text-delta':
      return appendText(state, event.text, timestamp, event.textBlock)
    case 'thinking-delta':
      return appendThinking(state, event.text)
    case 'thinking-end':
      return endThinking(state, event.durationMs)
    case 'model-request-retry':
      return appendBlock(state, {
        kind: 'model-request-retry', id: nextBlockId(state),
        retry: event.retry, maxRetries: event.maxRetries, message: event.message,
      })
    case 'context-compaction':
    case 'context-compacted':
      return applyCompaction(state, event)
    case 'work-finished': {
      // BTW 的成功回复由独立工作终点确认；普通回合使用执行层的 turn-end。
      const finished = event.btw && event.outcome === 'completed' ? confirmTurnResponse(state) : state
      const blocks = updateWorkText(finished.blocks, block => {
        if (block.phase === 'final') return timestamp ? { ...block, timestamp } : block
        return block.phase === 'activity' ? block : { ...block, phase: 'activity' }
      })
      const durationId = nextBlockId(state)
      const next = appendBlock({ ...finished, blocks, pendingStep: null }, {
        kind: 'work-duration',
        id: durationId,
        forkTurnId: event.forkTurnId,
        durationMs: event.durationMs,
        outcome: event.outcome,
        ...(event.error ? { error: event.error } : {}),
      })
      // 只有已提交的最终正文才能收起处理过程；工具等待、错误和停止都保持展开。
      // 用户已在最终正文阶段手动展开时，既有 expanded 身份会原样保留。
      const btwContinuation = event.btw?.continuationAvailable
        ? {
            conversationId: event.btw.conversationId,
            turnIndex: event.btw.turnIndex,
          }
        : null
      const settled = { ...next, pendingBtw: null, btwContinuation }
      if (hasCurrentWorkFinalText(blocks)) return settled
      const expanded = new Set(settled.expanded)
      expanded.add(currentWorkSectionId(blocks, durationId))
      return { ...settled, expanded, questionAnswersBeforeTool: {} }
    }
    case 'tool-start': {
      const answers = state.questionAnswersBeforeTool[event.toolUseId]
      if (answers) {
        const remaining = { ...state.questionAnswersBeforeTool }
        delete remaining[event.toolUseId]
        state = { ...state, questionAnswersBeforeTool: remaining }
      }
      return appendBlock(state, {
        kind: 'tool',
        id: nextBlockId(state),
        call: {
          id: event.toolUseId,
          name: event.toolName,
          ...(answers ? { questionAnswers: answers } : {}),
          input: visibleToolInput(state, event.toolName, event.input),
          status: 'running',
          progress: '',
        },
      })
    }
    case 'tool-progress':
      return updateTool(state, event.toolUseId, (call) => ({
        ...call,
        progress: appendVisibleToolOutput(call.progress, event.output),
      }))
    case 'tool-end':
      return updateTool(state, event.toolUseId, (call) => ({
        ...call,
        status: event.isError ? 'error' : 'done',
        result: visibleToolResult(event.result),
        ...(event.fileChanges
          ? { fileChanges: event.fileChanges.map((change) => ({ ...change })) }
          : {}),
      }))
    case 'image-viewed':
      return updateTool(state, event.toolUseId, (call) => ({
        ...call,
        attachments: event.attachments.map((attachment) => structuredClone(attachment)),
      }))
    case 'checkpoint-created':
      // 该事件已确认产生真实文件差异，因此先结束旧回滚标记；只有完整覆盖
      // 才能继续兑现新的恢复承诺，partial 不展示回滚入口。
      if (event.coverage !== 'complete') {
        return {
          ...state,
          fileRollbackBoundaryTurnId: null,
          fileSystemRevision: state.fileSystemRevision + 1,
        }
      }
      return {
        ...updateTool(state, event.toolUseId, (call) => ({
          ...call,
          hasCheckpoint: true,
          checkpointId: event.hash,
        })),
        // checkpoint-created 只会在写类工具成功产生真实文件差异后出现。
        fileRollbackBoundaryTurnId: null,
        fileSystemRevision: state.fileSystemRevision + 1,
      }
    case 'checkpoint-restored':
      return applyCheckpointRestored(state, event)
    case 'user-question':
      return { ...state, pendingQuestions: [...state.pendingQuestions, ...questionsForBatch(event.question)] }
    case 'user-question-resolved':
      return resolveQuestions(state, event.resolutions)
    case 'peer-event':
      return applyPeerCoreEvent(state, event.agentId, event.event)
    case 'vote-cast':
      return applyVote(state, event)
    case 'candidate-submitted': {
      const id = nextBlockId(state)
      const next = appendBlock(state, {
        kind: 'candidate',
        id,
        candidate: {
          agentId: event.agentId,
          candidateId: event.candidateId,
          summary: event.summary,
          details: event.details,
        },
      })
      return { ...next, expanded: new Set(next.expanded).add(id) }
    }
    case 'task-plan-updated':
    case 'task-plan-restored':
      return { ...state, taskPlan: structuredClone(event.plan) }
    default:
      return state
  }
}

function snapshotConversation(state: ConversationState): PendingStepSnapshot {
  return {
    blocks: state.blocks,
    nextId: state.nextId,
    taskPlan: state.taskPlan,
    fileRollbackBoundaryTurnId: state.fileRollbackBoundaryTurnId,
  }
}

function commitPendingStep(state: ConversationState): ConversationState {
  const snapshot = state.pendingStep
  if (!snapshot) return state
  const start = snapshot.blocks.length
  const hasToolCalls = state.blocks.slice(start).some(block => block.kind === 'tool')
  return { ...state, blocks: commitResponseText(state.blocks, hasToolCalls, start), pendingStep: null }
}

function commitResponseText(blocks: Block[], hasToolCalls: boolean, start?: number): Block[] {
  return updateWorkText(blocks, block => {
    if (block.phase === 'pending') return { ...block, phase: hasToolCalls ? 'activity' : 'response' }
    return block.phase === 'activity' ? block : { ...block, phase: 'activity' }
  }, start)
}

function confirmTurnResponse(state: ConversationState): ConversationState {
  const blocks = updateWorkText(state.blocks, block =>
    block.phase === 'response' ? { ...block, phase: 'final' } : block)
  return { ...state, blocks }
}

function continueWork(state: ConversationState): ConversationState {
  const blocks = updateWorkText(state.blocks, block =>
    block.phase === 'response' || block.phase === 'final' ? { ...block, phase: 'activity' } : block)
  return blocks === state.blocks ? state : { ...state, blocks }
}

function beginPendingStep(state: ConversationState): ConversationState {
  const current = continueWork(state)
  return { ...current, pendingStep: snapshotConversation(current) }
}

function retainStepOutput(state: ConversationState): ConversationState {
  const snapshot = state.pendingStep
  if (!snapshot) return state
  let retained: ConversationState = { ...state, ...snapshot, pendingStep: null }
  const start = snapshot.blocks.length
  for (const block of state.blocks.slice(start)) {
    if (block.kind === 'text') retained = appendText(retained, block.text, block.timestamp, block.textBlock)
  }
  return { ...retained, blocks: updateWorkText(retained.blocks, block => ({ ...block, phase: 'activity' }), start) }
}

export function appendUserMessage(
  state: ConversationState,
  text: string,
  startsTurn: boolean,
  attachments: readonly ImageAttachment[] = [],
  pdfAttachments: readonly PdfAttachment[] = [],
  skills: readonly SkillSummary[] = [],
  inputId?: string,
  timestamp?: string,
  btw?: { conversationId: string; turnIndex: number; mode: BtwMode },
): ConversationState {
  state = continueWork(state)
  const pendingTurnStart = startsTurn ? state.blocks.length : state.pendingTurnStart
  return appendBlock({
    ...state,
    pendingTurnStart,
    pendingBtw: btw ? structuredClone(btw) : null,
    btwContinuation: null,
  }, {
    kind: 'user',
    id: nextBlockId(state),
    ...(inputId ? { inputId } : {}),
    ...(startsTurn ? { startsTurn: true } : {}),
    ...(timestamp ? { timestamp } : {}),
    text,
    ...(attachments.length ? { attachments: attachments.map((item) => structuredClone(item)) } : {}),
    ...(pdfAttachments.length
      ? { pdfAttachments: pdfAttachments.map((item) => structuredClone(item)) }
      : {}),
    ...(skills.length ? { skills: skills.map((item) => structuredClone(item)) } : {}),
    ...(btw ? { btw: structuredClone(btw) } : {}),
  })
}

function visibleToolInput(
  state: ConversationState,
  toolName: string,
  input: unknown,
): unknown {
  if (
    toolName !== 'CloseTaskPlan'
    || !state.taskPlan
    || input === null
    || typeof input !== 'object'
    || Array.isArray(input)
  ) return input
  return { ...input, plan_id: state.taskPlan.id }
}

function resetPendingQuestions(state: ConversationState, questions: PendingQuestion[]): ConversationState {
  const open = new Set(questions.map(item => item.id))
  const blocks = state.blocks.map(block => {
    if (block.kind !== 'tool' || !block.call.questionAnswers) return block
    const entries = Object.entries(block.call.questionAnswers)
    const retained = entries.filter(([id]) => !open.has(id))
    return entries.length === retained.length ? block : { ...block, call: { ...block.call, questionAnswers: Object.fromEntries(retained) } }
  })
  return { ...state, blocks, pendingQuestions: questions, questionAnswersBeforeTool: {} }
}

function resolveQuestions(state: ConversationState, resolutions: QuestionReply): ConversationState {
  const answers = new Map(resolutions.map(item => [item.id, item.answer]))
  const byTool = new Map<string, Record<string, string | null>>()
  const pendingQuestions = state.pendingQuestions.filter(question => {
    const value = answers.get(question.id)
    if (value === undefined) return true
    const answer = value !== null && typeof value === 'object' ? '见用户回复' : value
    const group = byTool.get(question.toolUseId)
    if (group) group[question.id] = answer
    else byTool.set(question.toolUseId, { [question.id]: answer })
    return false
  })
  if (!byTool.size) return state
  const beforeTool = { ...state.questionAnswersBeforeTool }
  const attach = (blocks: Block[]): Block[] => {
    let updated = blocks
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]!
      if (block.kind !== 'tool') continue
      const group = byTool.get(block.call.id)
      if (!group) continue
      if (updated === blocks) updated = [...blocks]
      updated[i] = { ...block, call: { ...block.call, questionAnswers: { ...block.call.questionAnswers, ...group } } }
      delete beforeTool[block.call.id]
    }
    return updated
  }
  for (const [id, group] of byTool) beforeTool[id] = { ...beforeTool[id], ...group }
  const blocks = attach(state.blocks)
  const pendingStep = state.pendingStep && { ...state.pendingStep, blocks: attach(state.pendingStep.blocks) }
  return { ...state, blocks, pendingStep, pendingQuestions, questionAnswersBeforeTool: beforeTool }
}

export function editableUserBlockId(blocks: readonly Block[]): string | null {
  const candidate = blocks.findLast(block => block.kind === 'user' && (block.startsTurn || block.turnId || block.btw))
  return candidate?.kind === 'user'
    && (candidate.turnId || (candidate.btw && candidate.inputId))
    ? candidate.id
    : null
}

function applyBtwMessageEdited(
  state: ConversationState,
  event: Extract<CoreEvent, { type: 'btw-message-edited' }>,
  timestamp?: string,
): ConversationState {
  const previousIndex = state.blocks.findIndex((block) =>
    block.kind === 'user' && block.inputId === event.previousInputId)
  if (previousIndex < 0) return state
  const previous = state.blocks[previousIndex] as Extract<Block, { kind: 'user' }>
  if (!previous.btw) return state
  const replayInput = state.blocks.find((block) =>
    block.kind === 'user' && block.inputId === event.inputId)
  const replacement = replayInput?.kind === 'user' ? replayInput : previous
  const blocks: Block[] = [
    ...state.blocks.slice(0, previousIndex),
    {
      ...replacement,
      id: previous.id,
      inputId: event.inputId,
      text: event.text,
      timestamp: replayInput?.kind === 'user'
        ? replayInput.timestamp ?? timestamp
        : timestamp ?? previous.timestamp,
      btw: structuredClone(event.btw),
    },
  ]
  const retainedIds = new Set(blocks.map((block) => block.id))
  return {
    ...state,
    blocks,
    expanded: new Set([...state.expanded].filter((id) => retainedIds.has(id))),
    pendingTurnStart: null,
    turnStartBlocks: new Map(
      [...state.turnStartBlocks].filter(([, index]) => index < previousIndex),
    ),
    pendingStep: null,
    btwContinuation: null,
    pendingBtw: structuredClone(event.btw),
  }
}

function applyUserMessageEdited(
  state: ConversationState,
  event: Extract<CoreEvent, { type: 'user-message-edited' }>,
  timestamp?: string,
): ConversationState {
  const previousIndex = state.blocks.findIndex((block) =>
    block.kind === 'user' && block.turnId === event.previousTurnId)
  if (previousIndex < 0) return state
  const previous = state.blocks[previousIndex] as Extract<Block, { kind: 'user' }>
  const replayInput = state.blocks.find((block) =>
    block.kind === 'user' && block.inputId === event.inputId)
  const replacement = replayInput?.kind === 'user' ? replayInput : previous
  const { turnId: _discardedTurnId, ...replacementWithoutTurn } = replacement
  const blocks: Block[] = [
    ...state.blocks.slice(0, previousIndex),
    {
      ...replacementWithoutTurn,
      id: previous.id,
      inputId: event.inputId,
      text: event.text,
      timestamp: replayInput?.kind === 'user'
        ? replayInput.timestamp ?? timestamp
        : timestamp ?? previous.timestamp,
    },
  ]
  const retainedIds = new Set(blocks.map((block) => block.id))
  const turnStartBlocks = new Map(
    [...state.turnStartBlocks].filter(([, index]) => index < previousIndex),
  )
  const edited = {
    ...state,
    blocks,
    expanded: new Set([...state.expanded].filter((id) => retainedIds.has(id))),
    pendingTurnStart: previousIndex,
    turnStartBlocks,
    taskPlan: structuredClone(event.taskPlan),
    fileRollbackBoundaryTurnId: null,
    pendingStep: null,
  }
  const restored = resetPendingQuestions(edited, event.questions ?? [])
  return event.questionReply ? resolveQuestions(restored, event.questionReply) : restored
}

export function toggleExpanded(state: ConversationState, id: string): ConversationState {
  const expanded = new Set(state.expanded)
  expanded.has(id) ? expanded.delete(id) : expanded.add(id)
  return { ...state, expanded }
}

export function isTerminalResponseBlock(
  block: Block | undefined,
): block is TextBlock & { phase: 'final' } {
  return block?.kind === 'text' && block.phase === 'final'
}

function hasCurrentWorkFinalText(blocks: readonly Block[]): boolean {
  const workStart = blocks.findLastIndex((block) => block.kind === 'work-duration') + 1
  return blocks.slice(workStart).some(isTerminalResponseBlock)
}

/** 与会话投影使用同一工作区身份：上一条时长之后，从本轮首条用户消息开始。 */
function currentWorkSectionId(blocks: readonly Block[], boundaryId: string): string {
  let segmentStart = 0
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (blocks[index]?.kind === 'work-duration') {
      segmentStart = index + 1
      break
    }
  }
  const segment = blocks.slice(segmentStart)
  const userIndex = segment.findIndex((block) => block.kind === 'user')
  const firstWorkBlock = segment[userIndex >= 0 ? userIndex : 0]
  return workSectionId(firstWorkBlock, boundaryId)
}

/** 重发会保留用户消息的定位块，但新的输入不能继承旧执行过程的开合身份。 */
export function workSectionId(firstBlock: Block | undefined, boundaryId: string): string {
  const inputId = firstBlock?.kind === 'user' ? firstBlock.inputId : undefined
  return `work-${inputId ?? firstBlock?.id ?? boundaryId}`
}

export function createPeerBlock(agentId: 'B' | 'C'): PeerBlockData {
  return { agentId, status: 'working', text: '', tools: [] }
}

export function applyPeerEvent(data: PeerBlockData, event: CoreEvent): PeerBlockData {
  switch (event.type) {
    case 'text-delta':
      return { ...data, text: data.text + event.text }
    case 'tool-start':
      return {
        ...data,
        tools: [
          ...data.tools,
          {
            id: event.toolUseId,
            name: event.toolName,
            summary: summarizeToolCall(event.toolName, event.input),
            isError: false,
          },
        ],
      }
    case 'tool-end':
      return {
        ...data,
        tools: data.tools.map((tool) =>
          tool.id === event.toolUseId ? { ...tool, isError: event.isError } : tool,
        ),
      }
    default:
      return data
  }
}

function applyPeerCoreEvent(
  state: ConversationState,
  agentId: 'B' | 'C',
  event: CoreEvent,
): ConversationState {
  const idx = state.blocks.findLastIndex(
    (block) => block.kind === 'peer' && block.peer.agentId === agentId && block.peer.status === 'working',
  )
  if (idx < 0) {
    return appendBlock(state, {
      kind: 'peer',
      id: nextBlockId(state),
      peer: applyPeerEvent(createPeerBlock(agentId), event),
    })
  }
  const block = state.blocks[idx]! as Extract<Block, { kind: 'peer' }>
  const blocks = [...state.blocks]
  blocks[idx] = { ...block, peer: applyPeerEvent(block.peer, event) }
  return { ...state, blocks }
}

function applyVote(
  state: ConversationState,
  event: Extract<CoreEvent, { type: 'vote-cast' }>,
): ConversationState {
  const idx = state.blocks.findLastIndex(
    (block) =>
      block.kind === 'peer' &&
      block.peer.agentId === event.from &&
      block.peer.status === 'working',
  )
  if (idx < 0) return state
  const block = state.blocks[idx]! as Extract<Block, { kind: 'peer' }>
  const blocks = [...state.blocks]
  blocks[idx] = {
    ...block,
    peer: {
      ...block.peer,
      status: 'done',
      vote: {
        vote: event.vote,
        reason: event.reason,
        suggestedChange: event.suggestedChange,
      },
    },
  }
  return { ...state, blocks }
}

function applyCheckpointRestored(
  state: ConversationState,
  event: Extract<CoreEvent, { type: 'checkpoint-restored' }>,
): ConversationState {
  // 成功与失败的即时反馈由视口提示承载；这里只投影成功恢复产生的持久状态变化。
  if (!event.ok) return state
  let blocks = state.blocks
  const invalidated = new Set(event.invalidatedToolUseIds ?? [event.toolUseId])
  blocks = blocks.map((block) =>
    block.kind === 'tool' && invalidated.has(block.call.id)
      ? { ...block, call: { ...block.call, hasCheckpoint: false } }
      : block,
  )
  if (event.scope === 'files-and-chat') {
    let idx = state.turnStartBlocks.get(event.turnId) ?? -1
    if (idx < 0) {
      const toolIdx = blocks.findIndex(
        (block) => block.kind === 'tool' && block.call.id === event.toolUseId,
      )
      idx = toolIdx
      for (let i = toolIdx; i >= 0; i--) {
        if (blocks[i]!.kind === 'user') {
          idx = i
          break
        }
      }
    }
    if (idx >= 0) blocks = blocks.slice(0, idx)
  }
  const taskPlan = event.scope === 'files-and-chat' && event.taskPlan !== undefined
    ? structuredClone(event.taskPlan)
    : state.taskPlan
  const restored = {
    ...state,
    blocks,
    taskPlan,
    fileRollbackBoundaryTurnId: event.scope === 'files' ? event.turnId : null,
    fileSystemRevision: state.fileSystemRevision + 1,
  }
  return event.scope === 'files-and-chat' ? resetPendingQuestions(restored, event.questions ?? []) : restored
}

function appendText(
  state: ConversationState,
  text: string,
  timestamp?: string,
  textBlock?: number,
): ConversationState {
  let index = state.blocks.length - 1
  if (textBlock !== undefined) {
    // 同一步骤可交错传递不同正文的片段。按模型正文身份续写，已提交的步骤封口。
    for (; index >= 0; index--) {
      const block = state.blocks[index]!
      if (block.kind === 'work-duration' || block.kind === 'user') break
      if (block.kind === 'text' && (block.phase !== 'pending' || block.textBlock === textBlock)) break
    }
  }
  const previous = state.blocks[index]
  if (previous?.kind === 'text' && previous.phase === 'pending' && previous.textBlock === textBlock) {
    const blocks = [...state.blocks]
    blocks[index] = { ...previous, text: previous.text + text, ...(timestamp ? { timestamp } : {}) }
    return { ...state, blocks }
  }
  return appendBlock(state, {
    kind: 'text',
    id: nextBlockId(state),
    text,
    phase: 'pending',
    ...(textBlock !== undefined ? { textBlock } : {}),
    ...(timestamp ? { timestamp } : {}),
  })
}

type TextBlock = Extract<Block, { kind: 'text' }>

/** 只检查本次工作区间，有正文实际变化时才复制块数组。 */
function updateWorkText(
  blocks: Block[],
  update: (block: TextBlock) => TextBlock,
  start = blocks.findLastIndex(block => block.kind === 'work-duration') + 1,
): Block[] {
  let result = blocks
  for (let index = start; index < blocks.length; index++) {
    const block = blocks[index]!
    if (block.kind !== 'text') continue
    const updated = update(block)
    if (updated === block) continue
    if (result === blocks) result = [...blocks]
    result[index] = updated
  }
  return result
}

function appendThinking(state: ConversationState, text: string): ConversationState {
  const last = state.blocks.at(-1)
  if (last?.kind === 'thinking' && last.durationMs === null) {
    return {
      ...state,
      blocks: [...state.blocks.slice(0, -1), { ...last, text: last.text + text }],
    }
  }
  return appendBlock(state, {
    kind: 'thinking',
    id: nextBlockId(state),
    text,
    durationMs: null,
  })
}

function endThinking(state: ConversationState, durationMs: number): ConversationState {
  const last = state.blocks.at(-1)
  if (last?.kind !== 'thinking' || last.durationMs !== null) return state
  return {
    ...state,
    blocks: [...state.blocks.slice(0, -1), { ...last, durationMs }],
  }
}

function updateTool(
  state: ConversationState,
  toolId: string,
  update: (call: ToolCall) => ToolCall,
): ConversationState {
  return {
    ...state,
    blocks: state.blocks.map((block) =>
      block.kind === 'tool' && block.call.id === toolId
        ? { ...block, call: update(block.call) }
        : block,
    ),
  }
}

function applyCompaction(state: ConversationState, event: Extract<CoreEvent, { type: 'context-compaction' | 'context-compacted' }>): ConversationState {
  if (event.type === 'context-compacted' && event.level === 'micro') return state
  const index = state.compactionCount + 1
  const id = event.compactionId ?? nextBlockId(state)
  const start = event.compactionId ? state.blocks.findLastIndex(block => block.id === id) : -1
  const previous = state.blocks[start]
  // 恢复快照可能已包含随后送达的同一完成事件。
  if (previous?.kind === 'compaction' && previous.status === 'completed') return state
  const block: Block = event.type === 'context-compacted'
    ? { kind: 'compaction', id, index, status: 'completed', preTokens: event.preTokens, postTokens: event.postTokens }
    : { kind: 'compaction', id, index, status: event.status }
  const next = block.status === 'completed' ? { ...state, compactionCount: index } : state
  if (start < 0) return appendBlock(next, block)
  return { ...next, blocks: next.blocks.with(start, block) }
}

function appendBlock(state: ConversationState, block: Block): ConversationState {
  return { ...state, blocks: [...state.blocks, block], nextId: state.nextId + 1 }
}

function nextBlockId(state: ConversationState): string {
  return `b${state.nextId}`
}
