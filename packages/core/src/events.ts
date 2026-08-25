/**
 * CoreEvent / CoreCommand 协议 —— core 与宿主（Electron Main / 未来的宠物桥）之间的唯一边界。
 *
 * 硬性约束：
 * - 所有类型必须 JSON-safe（可 structuredClone / JSON.stringify），未来跨进程传输不改协议。
 * - 新增事件只允许追加 type，不允许修改已有字段语义（宠物侧会依赖子集）。
 * - 新增事件必须同步更新宿主适配、可见事件契约、恢复投影与对应测试。
 */

import type { ActiveTaskPlan, TaskPlan } from './tasks/types.ts'
import type {
  ImageAttachment,
  ImageDeliveryMode,
  ImageMessageAttachmentInput,
} from './attachments/types.ts'
import type { PdfAttachment, PdfMessageAttachmentInput } from './pdf/types.ts'
import type { ReasoningEffortSelection } from './providers/catalog.ts'
import type { SkillLocator, SkillSummary } from './skills/types.ts'
import { unicodeSafeSuffix } from './text.ts'

/** 工具完整输出由工具日志和模型消息持有；可见时间线只保留有界尾部。 */
export const MAX_VISIBLE_TOOL_OUTPUT_CHARS = 64 * 1024
const OMITTED_TOOL_OUTPUT_PREFIX = '[较早的工具输出已省略]\n'

export function truncateVisibleToolOutput(output: string): string {
  if (output.length <= MAX_VISIBLE_TOOL_OUTPUT_CHARS) return output
  return OMITTED_TOOL_OUTPUT_PREFIX + unicodeSafeSuffix(
    output,
    MAX_VISIBLE_TOOL_OUTPUT_CHARS - OMITTED_TOOL_OUTPUT_PREFIX.length,
  )
}

/** 追加工具进度时避免先构造无界中间字符串。 */
export function appendVisibleToolOutput(previous: string, next: string): string {
  const bodyLimit = MAX_VISIBLE_TOOL_OUTPUT_CHARS - OMITTED_TOOL_OUTPUT_PREFIX.length
  if (next.length >= bodyLimit) {
    return OMITTED_TOOL_OUTPUT_PREFIX + unicodeSafeSuffix(next, bodyLimit)
  }
  const previousBody = previous.startsWith(OMITTED_TOOL_OUTPUT_PREFIX)
    ? previous.slice(OMITTED_TOOL_OUTPUT_PREFIX.length)
    : previous
  if (
    !previous.startsWith(OMITTED_TOOL_OUTPUT_PREFIX)
    && previousBody.length + next.length <= MAX_VISIBLE_TOOL_OUTPUT_CHARS
  ) return previousBody + next
  return OMITTED_TOOL_OUTPUT_PREFIX
    + unicodeSafeSuffix(previousBody, bodyLimit - next.length)
    + next
}

export function visibleToolResult(result: unknown): string {
  if (typeof result === 'string') return truncateVisibleToolOutput(result)
  try {
    return truncateVisibleToolOutput(JSON.stringify(result) ?? String(result))
  } catch {
    return truncateVisibleToolOutput(String(result))
  }
}

/** 单轮对话的 token 用量与成本统计 */
export interface UsageInfo {
  inputTokens: number
  outputTokens: number
  /** 命中缓存读取的 token 数（provider 支持时） */
  cachedInputTokens: number
  /** 累计估算成本（美元） */
  costUsd: number
}

/** 当前模型请求上下文的统一估算；分项用于解释占用，total 优先采用 Provider usage 基线。 */
export interface ContextUsageInfo {
  usedTokens: number
  contextWindow: number
  /** 达到该压力后，在下一次模型请求前自动压缩。 */
  autoCompactThreshold: number
  breakdown: {
    systemPromptTokens: number
    toolTokens: number
    messageTokens: number
  }
}

export interface UserQuestionOption {
  label: string
  description: string
}

export const MAX_USER_QUESTIONS = 6

export interface UserQuestionItem {
  header: string
  question: string
  options: UserQuestionOption[]
}

/** Main 需要用户决策时展示的可恢复问题卡。 */
export interface UserQuestion {
  id: string
  questions: UserQuestionItem[]
}

export function formatUserQuestionAnswer(
  question: UserQuestion,
  answers: readonly string[],
): string {
  const items = question.questions
  if (answers.length !== items.length || answers.some((answer) => !answer.trim())) {
    throw new Error('每个问题都需要非空回答')
  }
  return items
    .map((item, index) =>
      `${userQuestionAnswerPrefix(item, index, items.length)}${normalizeInlineText(answers[index]!)}`)
    .join('\n')
}

export function userQuestionAnswerPrefix(
  item: UserQuestionItem,
  index: number,
  total: number,
): string {
  const label = normalizeInlineText(item.question)
  return total === 1 ? `回答「${label}」：` : `${index + 1}. 回答「${label}」：`
}

function normalizeInlineText(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim()
}

/** 忙时输入始终把正文和附件作为一个有序单元传递、恢复和展示。 */
export interface QueuedUserMessage {
  id: string
  text: string
  attachments?: ImageAttachment[]
  imageDelivery?: ImageDeliveryMode
  pdfAttachments?: PdfAttachment[]
  skills?: SkillSummary[]
}

/** Agent 整体状态，宠物接口消费的核心事件 */
export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'waiting-approval'
  | 'error'

/** core → 宿主 的事件流 */
export type CoreEvent =
  | { type: 'turn-start'; turnId: string }
  /** 当前 step 的模型消息已提交到稳定会话记录；宿主可据此提交对应可见事件。 */
  | { type: 'step-committed' }
  /** 当前 step 未进入模型历史（取消/urgent/异常）；宿主必须丢弃对应未提交可见事件。 */
  | { type: 'step-discarded' }
  /** 用户主动停止时仅提交已展示的正文；工具、推理、问题和计划仍由随后 discard 撤销。 */
  | { type: 'step-output-retained' }
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'thinking-end'; durationMs: number }
  | { type: 'tool-start'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool-progress'; toolUseId: string; output: string }
  | { type: 'tool-end'; toolUseId: string; result: unknown; isError: boolean }
  /** 视觉工具已把图片安全复制进当前会话；元数据随所属稳定 step 可恢复。 */
  | { type: 'image-viewed'; toolUseId: string; attachments: ImageAttachment[] }
  | {
      type: 'approval-request'
      requestId: string
      toolName: string
      input: unknown
      /** 为什么需要审批（权限引擎给出） */
      reason: string
      /** 写文件类工具附带的变更预览（unified diff 文本） */
      diff?: string
      /** 同一模型步骤内共同审批的精确工具调用；单项审批省略。 */
      items?: readonly {
        toolCallId: string
        toolName: string
        input: unknown
        reason: string
        diff?: string
      }[]
      /** 批准时可选择「本会话记住」的建议（无则只能单次批准） */
      suggestion?: { kind: 'add-dir'; dir: string } | { kind: 'allow-tool'; toolName: string }
    }
  | { type: 'turn-end'; turnId: string; usage: UsageInfo; stopReason: StopReason }
  /** Main runtime 接受根输入后的权威起点；仅用于当前运行中的计时显示。 */
  | { type: 'work-started'; startedAt: number }
  /** 整次连续工作结束后的固定时长与终止来源；进入可见时间线以供重启恢复。 */
  | {
      type: 'work-finished'
      durationMs: number
      outcome: 'completed' | 'stopped'
      /** 整段工作最后一个完整结束的模型回复；null 表示没有可 Fork 边界。 */
      forkTurnId: string | null
    }
  | { type: 'agent-status'; status: AgentStatus }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'user-question'; question: UserQuestion }
  /** 宿主已把空闲输入权威分类为新根消息；仅供当前窗口即时显示，不进入 ViewTimeline。 */
  | {
      type: 'user-message-accepted'
      /** 新宿主提供的稳定根输入身份；旧宿主事件允许省略。 */
      inputId?: string
      text: string
      startsTurn: true
      attachments?: ImageAttachment[]
      pdfAttachments?: PdfAttachment[]
      skills?: SkillSummary[]
    }
  /**
   * 用户把最新一条根消息原位改写。该事件只负责实时投影；
   * 重放由 JSONL user-input.replacesTurnId 派生同一事件，避免维护第二份界面状态。
   */
  | {
      type: 'user-message-edited'
      previousTurnId: string
      inputId: string
      text: string
      taskPlan: ActiveTaskPlan | null
    }
  // --- steering（M2-a）：运行中插话 ---
  | {
      type: 'message-queued'
      id: string
      text: string
      attachments?: ImageAttachment[]
      pdfAttachments?: PdfAttachment[]
      skills?: SkillSummary[]
    }
  | {
      type: 'message-injected'
      id: string
      text: string
      startsTurn?: boolean
      attachments?: ImageAttachment[]
      pdfAttachments?: PdfAttachment[]
      skills?: SkillSummary[]
    }
  /** 中断后把排队文本还给输入框（不静默丢弃） */
  | { type: 'queue-restored'; text: string; items?: QueuedUserMessage[] }
  // --- 检查点（M2-c）---
  /** 写类工具的 before/after 资源清单已持久化；hash 当前承载稳定 checkpointId。 */
  | {
      type: 'checkpoint-created'
      toolUseId: string
      hash: string
      coverage: 'complete' | 'partial'
      warning?: string
    }
  | {
      type: 'checkpoint-restored'
      toolUseId: string
      /** 所属 turn（files-and-chat 回滚时 UI 据此截断到 turn 起点） */
      turnId: string
      scope: 'files' | 'files-and-chat'
      ok: boolean
      error?: string
      /** 本次逆向恢复会同时使这些较新的回滚点失效。 */
      invalidatedToolUseIds?: string[]
      /** 文件+对话回滚后的活动任务计划；省略表示本次未改变任务状态。 */
      taskPlan?: TaskPlan | null
      /** 文件+对话回滚后重新生效的等待问题；null 表示回滚点没有待回答问题。 */
      question?: UserQuestion | null
    }
  /** 精确文件检查点建立失败；同一会话只提示一次 */
  | { type: 'checkpoint-disabled'; reason: string }
  // --- 上下文压缩（M2-d）---
  | {
      type: 'context-compacted'
      /** micro = 仅清理旧工具输出；full = 摘要压缩 */
      level: 'micro' | 'full'
      preTokens: number
      postTokens: number
    }
  /** 仅供宿主运行态展示，不进入会话时间线；null 表示模型切换后等待重新估算。 */
  | { type: 'context-usage'; usage: ContextUsageInfo | null }
  // --- 多 Agent 协商（M3）---
  /** 协议模式锁定为需评审的模式，B/C 开始工作（main_only 不发） */
  | { type: 'negotiation-started'; taskId: string; mode: 'quick_review' | 'full_consensus' }
  | { type: 'round-started'; taskId: string; round: 2 | 3 }
  | {
      type: 'candidate-submitted'
      agentId: 'Main' | 'B' | 'C'
      candidateId: string
      summary: string
      /** 正式候选的实质分析；main_only 不展开候选。scratch 临时路径不进入 UI 事件。 */
      details?: {
        finalAnswerOrPlan: string
        evidenceRefs?: string[]
        knownRisks?: string[]
      }
    }
  | {
      type: 'vote-cast'
      from: 'Main' | 'B' | 'C'
      target: string
      vote: 'accept' | 'accept_with_minor_edits' | 'reject'
      reason: string
      suggestedChange?: string
    }
  | {
      type: 'negotiation-decided'
      taskId: string
      selectedCandidateIds: string[]
      reason: string
      /** full_consensus 时附带当前对话累计分数 */
      scores?: { Main: number; B: number; C: number }
    }
  | { type: 'execution-started'; taskId: string }
  /** 图片/PDF 轮次只交给 Main；未读取附件的 B/C 不参与表决。 */
  | { type: 'consensus-skipped'; reason: 'image-input' | 'pdf-input' }
  // --- Main 长任务控制 ---
  | { type: 'task-plan-updated'; plan: TaskPlan }
  /** 共识事务取消/异常时，把任务卡恢复到协商开始前。 */
  | { type: 'task-plan-restored'; plan: TaskPlan | null }
  /** B/C 讨论过程流的包装（UI 按 agentId 归集到折叠卡片） */
  | { type: 'peer-event'; agentId: 'B' | 'C'; event: CoreEvent }

/** Main → Renderer 与持久化时间线共用的有界工具展示投影。 */
export function compactVisibleCoreEvent(event: CoreEvent): CoreEvent {
  if (event.type === 'tool-progress') {
    return { ...event, output: truncateVisibleToolOutput(event.output) }
  }
  if (event.type === 'tool-end') {
    return { ...event, result: visibleToolResult(event.result) }
  }
  if (event.type === 'peer-event' && event.event.type === 'tool-end') {
    return {
      ...event,
      event: { ...event.event, result: visibleToolResult(event.event.result) },
    }
  }
  return event
}

type CoalescibleCoreEvent =
  | Extract<CoreEvent, { type: 'text-delta' | 'thinking-delta' | 'tool-progress' }>
  | {
      type: 'peer-event'
      agentId: 'B' | 'C'
      event: Extract<CoreEvent, { type: 'text-delta' }>
    }

/**
 * 合并严格相邻、语义等价的流式事件。调用方负责保留事件边界与顺序；
 * 返回 null 表示两项不能合并。该规则同时服务持久化与实时界面，避免两套投影漂移。
 */
export function coalesceAdjacentCoreEvent(
  previous: CoreEvent,
  next: CoreEvent,
): CoalescibleCoreEvent | null {
  if (previous.type === 'text-delta' && next.type === 'text-delta') {
    return { ...previous, text: previous.text + next.text }
  }
  if (previous.type === 'thinking-delta' && next.type === 'thinking-delta') {
    return { ...previous, text: previous.text + next.text }
  }
  if (
    previous.type === 'tool-progress'
    && next.type === 'tool-progress'
    && previous.toolUseId === next.toolUseId
  ) {
    return { ...previous, output: appendVisibleToolOutput(previous.output, next.output) }
  }
  if (
    previous.type === 'peer-event'
    && next.type === 'peer-event'
    && previous.agentId === next.agentId
    && previous.event.type === 'text-delta'
    && next.event.type === 'text-delta'
  ) {
    return {
      ...previous,
      event: { ...previous.event, text: previous.event.text + next.event.text },
    }
  }
  return null
}

const STEP_SCOPED_CORE_EVENT_TYPES = new Set<CoreEvent['type']>([
  'text-delta',
  'thinking-delta',
  'thinking-end',
  'tool-start',
  'tool-progress',
  'tool-end',
  'image-viewed',
  'checkpoint-created',
  'checkpoint-disabled',
  'task-plan-updated',
  'user-question',
])

/** 这些事件只有在所属模型步骤提交后才能成为稳定可见事实。 */
export function isStepScopedCoreEvent(event: CoreEvent): boolean {
  return STEP_SCOPED_CORE_EVENT_TYPES.has(event.type)
}

export type StopReason =
  | 'completed'
  | 'waiting-user'
  | 'paused'
  | 'aborted'
  | 'max-turns'
  | 'error'

/** 宿主 → core 的命令 */
export type CoreCommand =
  | {
      type: 'user-message'
      text: string
      /** true = 立即插话：打断当前步骤马上注入（Claude Code 的 now 语义）；默认排队到步骤间 */
      urgent?: boolean
      /** 有序图片来源；剪贴板 Base64 在主进程落盘后不得持久化。 */
      attachments?: ImageMessageAttachmentInput[]
      /** PDF 只跨 IPC 传路径或已恢复的附件 ID，不允许 inline Base64。 */
      pdfAttachments?: PdfMessageAttachmentInput[]
      /** 重新提交 queue-restored 草稿时原子消费的旧输入；只能引用当前会话事实源。 */
      restoredInputIds?: string[]
      /** Renderer 只提交目录中的精确 locator；主进程在落盘前解析为不可变 Skill 快照。 */
      skills?: SkillLocator[]
    }
  | {
      type: 'approval-response'
      requestId: string
      approved: boolean
      /** true = 采纳审批建议（本会话记住目录/工具） */
      remember?: boolean
    }
  | { type: 'abort' }
  | { type: 'set-model'; modelId: string }
  | { type: 'set-reasoning-effort'; reasoningEffort: ReasoningEffortSelection }
  | { type: 'set-permission-mode'; mode: 'readonly' | 'default' | 'acceptEdits' | 'auto' }
  /** 原位改写最新一条根消息，丢弃其原回答并从该位置重新执行。 */
  | { type: 'edit-user-message'; turnId: string; text: string }
  /** 回滚到某写操作执行前的快照（仅空闲时） */
  | { type: 'restore-checkpoint'; toolUseId: string; scope: 'files' | 'files-and-chat' }
  /** 手动触发上下文压缩（仅空闲时） */
  | { type: 'compact' }
  /** 开关多 Agent 协商（B/C 必须已选择可用的统一模型连接）。 */
  | { type: 'set-consensus'; enabled: boolean }

/** 事件回调签名：宿主注入给 core 的事件出口 */
export type CoreEventSink = (event: CoreEvent) => void
