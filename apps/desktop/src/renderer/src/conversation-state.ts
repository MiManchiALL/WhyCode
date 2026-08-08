import type {
  ImageAttachment,
  PdfAttachment,
  SkillSummary,
  TaskPlan,
  ViewEvent,
} from '@whycode/core'
import {
  isStepScopedCoreEvent,
  type CoreEvent,
  type UserQuestion,
} from '@whycode/core/events'
import type { RuntimeSnapshot } from '../../shared/session.ts'

export interface ToolCall {
  id: string
  name: string
  input: unknown
  status: 'running' | 'done' | 'error'
  result?: string
  progress: string
  /** 有持久化资源检查点；切换会话或重启后仍可回滚。 */
  hasCheckpoint?: boolean
  /** ViewImage 复制进当前会话的稳定图片元数据。 */
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
      text: string
      attachments?: ImageAttachment[]
      pdfAttachments?: PdfAttachment[]
      skills?: SkillSummary[]
    }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string; durationMs: number | null }
  | {
      kind: 'work-duration'
      id: string
      durationMs: number
      outcome: 'completed' | 'stopped'
    }
  | { kind: 'tool'; id: string; call: ToolCall }
  | { kind: 'notice'; id: string; text: string }
  | {
      kind: 'plan-replaced'
      id: string
      previous: Extract<TaskPlan, { status: 'superseded' }>
      nextGoal: string
    }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'candidate'; id: string; candidate: CandidateBlockData }
  | { kind: 'peer'; id: string; peer: PeerBlockData }

interface PendingStepSnapshot {
  blocks: Block[]
  nextId: number
  taskPlan: TaskPlan | null
  pendingQuestion: UserQuestion | null
}

export interface ConversationState {
  blocks: Block[]
  expanded: Set<string>
  nextId: number
  pendingTurnStart: number | null
  turnStartBlocks: Map<string, number>
  /** 当前/最近一个结构化计划；独立于聊天块，避免频繁进度更新刷屏。 */
  taskPlan: TaskPlan | null
  /** 最近一个尚未被用户消息回答的问题；由可见事件重放恢复。 */
  pendingQuestion: UserQuestion | null
  /** 实时模型步骤开始前的稳定界面；提交时清除，丢弃时原样恢复。 */
  pendingStep: PendingStepSnapshot | null
}

const VOTE_LABELS: Record<string, string> = {
  accept: '✅ 接受',
  accept_with_minor_edits: '☑️ 接受（小修改）',
  reject: '❌ 拒绝',
}

export function voteLabel(vote: string): string {
  return VOTE_LABELS[vote] ?? vote
}

export function createConversationState(events: readonly ViewEvent[] = []): ConversationState {
  let state: ConversationState = {
    blocks: [],
    expanded: new Set(),
    nextId: 0,
    pendingTurnStart: null,
    turnStartBlocks: new Map(),
    taskPlan: null,
    pendingQuestion: null,
    pendingStep: null,
  }
  for (const event of events) state = applyViewEvent(state, event)
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

export function eventsAfterRuntimeSnapshot(
  buffered: readonly { sequence: number; event: CoreEvent }[],
  snapshotSequence: number,
): CoreEvent[] {
  return buffered
    .filter((entry) => entry.sequence > snapshotSequence)
    .map((entry) => entry.event)
}

export function resumeTargetCommitted(
  snapshot: Pick<RuntimeSnapshot, 'resumingSessionId' | 'sessionId'>,
  targetSessionId: string,
): boolean {
  return snapshot.resumingSessionId === null && snapshot.sessionId === targetSessionId
}

export function applyViewEvent(state: ConversationState, event: ViewEvent): ConversationState {
  return event.type === 'user-message'
    ? appendUserMessage(
        state,
        event.text,
        event.startsTurn,
        event.attachments,
        event.pdfAttachments,
        event.skills,
        event.inputId,
      )
    : applyStableCoreEvent(state, event.event)
}

export function applyCoreEvent(state: ConversationState, event: CoreEvent): ConversationState {
  if (event.type === 'step-committed') {
    return state.pendingStep ? { ...state, pendingStep: null } : state
  }
  if (event.type === 'step-output-retained') return retainStepOutput(state)
  if (event.type === 'step-discarded') {
    return state.pendingStep
      ? { ...state, ...state.pendingStep, pendingStep: null }
      : state
  }
  const current = isStepScopedCoreEvent(event) && !state.pendingStep
    ? { ...state, pendingStep: snapshotConversation(state) }
    : state
  return applyStableCoreEvent(current, event)
}

function applyStableCoreEvent(state: ConversationState, event: CoreEvent): ConversationState {
  switch (event.type) {
    case 'turn-start': {
      if (state.pendingTurnStart === null) return state
      const turnStartBlocks = new Map(state.turnStartBlocks)
      turnStartBlocks.set(event.turnId, state.pendingTurnStart)
      const blocks = [...state.blocks]
      const root = blocks[state.pendingTurnStart]
      if (root?.kind === 'user') blocks[state.pendingTurnStart] = { ...root, turnId: event.turnId }
      return { ...state, blocks, pendingTurnStart: null, turnStartBlocks }
    }
    case 'user-message-edited':
      return applyUserMessageEdited(state, event)
    case 'message-injected':
      return appendUserMessage(
        state,
        event.text,
        event.startsTurn ?? false,
        event.attachments,
        event.pdfAttachments,
        event.skills,
        event.id,
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
      )
    case 'text-delta':
      return appendText(state, event.text)
    case 'thinking-delta':
      return appendThinking(state, event.text)
    case 'thinking-end':
      return endThinking(state, event.durationMs)
    case 'work-finished': {
      const durationId = nextBlockId(state)
      const next = appendBlock(state, {
        kind: 'work-duration',
        id: durationId,
        durationMs: event.durationMs,
        outcome: event.outcome,
      })
      if (event.outcome !== 'stopped') return next
      // 停止只冻结当时的展示：末尾正文已让处理过程收起时不反向展开。
      if (isTerminalResponseBlock(state.blocks.at(-1))) return next
      const expanded = new Set(next.expanded)
      expanded.add(currentWorkSectionId(state.blocks, durationId))
      return { ...next, expanded }
    }
    case 'tool-start':
      return appendBlock(state, {
        kind: 'tool',
        id: nextBlockId(state),
        call: {
          id: event.toolUseId,
          name: event.toolName,
          input: event.input,
          status: 'running',
          progress: '',
        },
      })
    case 'tool-progress':
      return updateTool(state, event.toolUseId, (call) => ({
        ...call,
        progress: call.progress + event.output,
      }))
    case 'tool-end':
      return updateTool(state, event.toolUseId, (call) => ({
        ...call,
        status: event.isError ? 'error' : 'done',
        result: String(event.result),
      }))
    case 'image-viewed':
      return updateTool(state, event.toolUseId, (call) => ({
        ...call,
        attachments: event.attachments.map((attachment) => structuredClone(attachment)),
      }))
    case 'checkpoint-created':
      // 只有完整精确覆盖才能兑现恢复承诺；partial 不具备可展示的回滚语义。
      if (event.coverage !== 'complete') return state
      return updateTool(state, event.toolUseId, (call) => ({
        ...call,
        hasCheckpoint: true,
      }))
    case 'checkpoint-disabled':
      return appendNotice(state, `检查点已禁用：${event.reason}`)
    case 'checkpoint-restored':
      return applyCheckpointRestored(state, event)
    case 'context-compacted':
      return appendNotice(
        state,
        `上下文已压缩（${event.level === 'full' ? '摘要' : '清理'}：${Math.round(event.preTokens / 1000)}k → ${Math.round(event.postTokens / 1000)}k tokens）`,
      )
    case 'error':
      return appendBlock(state, { kind: 'error', id: nextBlockId(state), text: event.message })
    case 'user-question':
      return { ...state, pendingQuestion: structuredClone(event.question) }
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
    case 'negotiation-started':
      return appendNotice(
        state,
        `🤝 协商开始（${event.mode === 'quick_review' ? '快速评审' : '完整共识'}）：B/C 正在独立评审…`,
      )
    case 'round-started':
      return appendNotice(state, `🔁 进入第 ${event.round} 轮协商`)
    case 'negotiation-decided':
      return appendNotice(
        state,
        `⚖️ 协商决定（${event.selectedCandidateIds.join('、') || '降级'}）：${event.reason}${
          event.scores
            ? `｜分数 Main ${event.scores.Main} / B ${event.scores.B} / C ${event.scores.C}`
            : ''
        }`,
      )
    case 'execution-started':
      return appendNotice(state, '▶ Main 进入执行阶段')
    case 'consensus-skipped':
      return appendNotice(
        state,
        event.reason === 'pdf-input'
          ? '📄 本轮含 PDF，仅由 Main 读取；B/C 未读取原文，已跳过协商。'
          : '🖼 本轮含图片，仅由当前视觉模型处理；B/C 未读取图片，已跳过协商。',
      )
    case 'task-plan-updated':
      return { ...state, taskPlan: structuredClone(event.plan) }
    case 'task-plan-replaced': {
      const next = appendBlock(state, {
        kind: 'plan-replaced',
        id: nextBlockId(state),
        previous: structuredClone(event.previous),
        nextGoal: event.plan.goal,
      })
      return { ...next, taskPlan: structuredClone(event.plan) }
    }
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
    pendingQuestion: state.pendingQuestion,
  }
}

function retainStepOutput(state: ConversationState): ConversationState {
  const snapshot = state.pendingStep
  if (!snapshot) return state
  const stableById = new Map(snapshot.blocks.map((block) => [block.id, block]))
  let retained: ConversationState = { ...state, ...snapshot, pendingStep: null }
  for (const block of state.blocks) {
    if (block.kind !== 'text') continue
    const stable = stableById.get(block.id)
    const text = stable?.kind === 'text'
      ? block.text.slice(stable.text.length)
      : block.text
    if (text) retained = appendText(retained, text)
  }
  return retained
}

export function appendUserMessage(
  state: ConversationState,
  text: string,
  startsTurn: boolean,
  attachments: readonly ImageAttachment[] = [],
  pdfAttachments: readonly PdfAttachment[] = [],
  skills: readonly SkillSummary[] = [],
  inputId?: string,
): ConversationState {
  const pendingTurnStart = startsTurn ? state.blocks.length : state.pendingTurnStart
  return appendBlock({ ...state, pendingTurnStart, pendingQuestion: null }, {
    kind: 'user',
    id: nextBlockId(state),
    ...(inputId ? { inputId } : {}),
    text,
    ...(attachments.length ? { attachments: attachments.map((item) => structuredClone(item)) } : {}),
    ...(pdfAttachments.length
      ? { pdfAttachments: pdfAttachments.map((item) => structuredClone(item)) }
      : {}),
    ...(skills.length ? { skills: skills.map((item) => structuredClone(item)) } : {}),
  })
}

export function editableUserBlockId(blocks: readonly Block[]): string | null {
  let index = blocks.length - 1
  let terminalWorkRecorded = false
  while (index >= 0 && blocks[index]?.kind === 'work-duration') {
    terminalWorkRecorded = true
    index--
  }
  const candidate = blocks[index]
  return terminalWorkRecorded && candidate?.kind === 'user' && candidate.turnId
    ? candidate.id
    : null
}

function applyUserMessageEdited(
  state: ConversationState,
  event: Extract<CoreEvent, { type: 'user-message-edited' }>,
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
    },
  ]
  const retainedIds = new Set(blocks.map((block) => block.id))
  const turnStartBlocks = new Map(
    [...state.turnStartBlocks].filter(([, index]) => index < previousIndex),
  )
  return {
    ...state,
    blocks,
    expanded: new Set([...state.expanded].filter((id) => retainedIds.has(id))),
    pendingTurnStart: previousIndex,
    turnStartBlocks,
    taskPlan: structuredClone(event.taskPlan),
    pendingQuestion: null,
    pendingStep: null,
  }
}

export function appendNotice(state: ConversationState, text: string): ConversationState {
  return appendBlock(state, { kind: 'notice', id: nextBlockId(state), text })
}

export function toggleExpanded(state: ConversationState, id: string): ConversationState {
  const expanded = new Set(state.expanded)
  expanded.has(id) ? expanded.delete(id) : expanded.add(id)
  return { ...state, expanded }
}

export function isTerminalResponseBlock(
  block: Block | undefined,
): block is Extract<Block, { kind: 'text' | 'error' }> {
  return block?.kind === 'text' || block?.kind === 'error'
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
  return `work-${firstWorkBlock?.id ?? boundaryId}`
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
            summary: summarizeToolInput(event.input),
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
  if (idx < 0) {
    return appendNotice(
      state,
      `${event.from} 对 ${event.target} 投票 ${voteLabel(event.vote)}：${event.reason}`,
    )
  }
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
  if (!event.ok) return appendBlock(state, {
    kind: 'error',
    id: nextBlockId(state),
    text: `回滚失败：${event.error}`,
  })
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
  return appendNotice(
    {
      ...state,
      blocks,
      taskPlan,
      pendingQuestion: event.scope === 'files-and-chat'
        ? structuredClone(event.question ?? null)
        : state.pendingQuestion,
    },
    event.scope === 'files-and-chat'
      ? '已回滚：该轮对话与文件改动均已撤销'
      : '已回滚检查点覆盖的文件（对话保留）',
  )
}

function appendText(state: ConversationState, text: string): ConversationState {
  const last = state.blocks.at(-1)
  if (last?.kind === 'text') {
    return {
      ...state,
      blocks: [...state.blocks.slice(0, -1), { ...last, text: last.text + text }],
    }
  }
  return appendBlock(state, { kind: 'text', id: nextBlockId(state), text })
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

function appendBlock(state: ConversationState, block: Block): ConversationState {
  return { ...state, blocks: [...state.blocks, block], nextId: state.nextId + 1 }
}

function nextBlockId(state: ConversationState): string {
  return `b${state.nextId}`
}

function summarizeToolInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const value = input as Record<string, unknown>
    if (typeof value.path === 'string') return value.path
    if (typeof value.pattern === 'string') return value.pattern
    if (typeof value.command === 'string') return value.command
  }
  return ''
}
