import type { TaskPlan, ViewEvent } from '@whycode/core'
import type { CoreEvent, UserQuestion } from '@whycode/core/events'

export interface ToolCall {
  id: string
  name: string
  input: unknown
  status: 'running' | 'done' | 'error'
  result?: string
  progress: string
  /** 有持久化资源检查点；切换会话或重启后仍可回滚。 */
  hasCheckpoint?: boolean
  checkpointCoverage?: 'complete' | 'partial'
  checkpointWarning?: string
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
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string; durationMs: number | null }
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
  }
  for (const event of events) state = applyViewEvent(state, event)
  return state
}

export function restoreRuntimeConversation(
  events: readonly ViewEvent[],
  busy: boolean,
): ConversationState {
  const restored = createConversationState(events)
  return busy
    ? appendNotice(
        restored,
        '界面已重新连接当前任务；未稳定提交的步骤不会伪造到历史中，可使用“停止”结束当前请求。',
      )
    : restored
}

export function eventsAfterRuntimeSnapshot(
  buffered: readonly { sequence: number; event: CoreEvent }[],
  snapshotSequence: number,
): CoreEvent[] {
  return buffered
    .filter((entry) => entry.sequence > snapshotSequence)
    .map((entry) => entry.event)
}

export function applyViewEvent(state: ConversationState, event: ViewEvent): ConversationState {
  return event.type === 'user-message'
    ? appendUserMessage(state, event.text, event.startsTurn)
    : applyCoreEvent(state, event.event)
}

export function applyCoreEvent(state: ConversationState, event: CoreEvent): ConversationState {
  switch (event.type) {
    case 'turn-start': {
      if (state.pendingTurnStart === null) return state
      const turnStartBlocks = new Map(state.turnStartBlocks)
      turnStartBlocks.set(event.turnId, state.pendingTurnStart)
      return { ...state, pendingTurnStart: null, turnStartBlocks }
    }
    case 'message-injected':
      return appendUserMessage(state, event.text, event.startsTurn ?? false)
    case 'user-message-accepted':
      return appendUserMessage(state, event.text, event.startsTurn)
    case 'text-delta':
      return appendText(state, event.text)
    case 'thinking-delta':
      return appendThinking(state, event.text)
    case 'thinking-end':
      return endThinking(state, event.durationMs)
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
    case 'checkpoint-created':
      return updateTool(state, event.toolUseId, (call) => ({
        ...call,
        hasCheckpoint: true,
        checkpointCoverage: event.coverage,
        checkpointWarning: event.warning,
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

export function appendUserMessage(
  state: ConversationState,
  text: string,
  startsTurn: boolean,
): ConversationState {
  const pendingTurnStart = startsTurn ? state.blocks.length : state.pendingTurnStart
  return appendBlock({ ...state, pendingTurnStart, pendingQuestion: null }, {
    kind: 'user',
    id: nextBlockId(state),
    text,
  })
}

export function appendNotice(state: ConversationState, text: string): ConversationState {
  return appendBlock(state, { kind: 'notice', id: nextBlockId(state), text })
}

export function toggleExpanded(state: ConversationState, id: string): ConversationState {
  const expanded = new Set(state.expanded)
  expanded.has(id) ? expanded.delete(id) : expanded.add(id)
  return { ...state, expanded }
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
