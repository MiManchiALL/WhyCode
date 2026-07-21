/**
 * CoreEvent / CoreCommand 协议 —— core 与宿主（Electron Main / 未来的宠物桥）之间的唯一边界。
 *
 * 硬性约束：
 * - 所有类型必须 JSON-safe（可 structuredClone / JSON.stringify），未来跨进程传输不改协议。
 * - 新增事件只允许追加 type，不允许修改已有字段语义（宠物侧会依赖子集）。
 * - 与 docs/02-技术栈与架构.md §6 保持同步，改这里必须改文档。
 */

import type { ActiveTaskPlan, SupersededTaskPlan, TaskPlan } from './tasks/types.ts'
import type { ImageAttachment, ImageMessageAttachmentInput } from './attachments/types.ts'
import type { PdfAttachment, PdfMessageAttachmentInput } from './pdf/types.ts'
import type { ReasoningEffortSelection } from './providers/catalog.ts'

/** 单轮对话的 token 用量与成本统计 */
export interface UsageInfo {
  inputTokens: number
  outputTokens: number
  /** 命中缓存读取的 token 数（provider 支持时） */
  cachedInputTokens: number
  /** 累计估算成本（美元） */
  costUsd: number
}

export interface UserQuestionOption {
  label: string
  description: string
}

/** Main 需要用户决策时展示的可恢复问题卡。 */
export interface UserQuestion {
  id: string
  header: string
  question: string
  options: UserQuestionOption[]
}

/** 忙时输入始终把正文和附件作为一个有序单元传递、恢复和展示。 */
export interface QueuedUserMessage {
  id: string
  text: string
  attachments?: ImageAttachment[]
  pdfAttachments?: PdfAttachment[]
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
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'thinking-end'; durationMs: number }
  | { type: 'tool-start'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool-progress'; toolUseId: string; output: string }
  | { type: 'tool-end'; toolUseId: string; result: unknown; isError: boolean }
  /** ViewImage 已把图片安全复制进当前会话；元数据随所属稳定 step 可恢复。 */
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
      /** 批准时可选择「本会话记住」的建议（无则只能单次批准） */
      suggestion?: { kind: 'add-dir'; dir: string } | { kind: 'allow-tool'; toolName: string }
    }
  | { type: 'turn-end'; turnId: string; usage: UsageInfo; stopReason: StopReason }
  | { type: 'agent-status'; status: AgentStatus }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'user-question'; question: UserQuestion }
  /** 宿主已把空闲输入权威分类为新根消息；仅供当前窗口即时显示，不进入 ViewTimeline。 */
  | {
      type: 'user-message-accepted'
      text: string
      startsTurn: true
      attachments?: ImageAttachment[]
      pdfAttachments?: PdfAttachment[]
    }
  // --- steering（M2-a）：运行中插话 ---
  | {
      type: 'message-queued'
      id: string
      text: string
      attachments?: ImageAttachment[]
      pdfAttachments?: PdfAttachment[]
    }
  | {
      type: 'message-injected'
      id: string
      text: string
      startsTurn?: boolean
      attachments?: ImageAttachment[]
      pdfAttachments?: PdfAttachment[]
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
  // --- 多 Agent 协商（M3）---
  /** 协议模式锁定为需评审的模式，B/C 开始工作（main_only 不发） */
  | { type: 'negotiation-started'; taskId: string; mode: 'quick_review' | 'full_consensus' }
  | { type: 'round-started'; taskId: string; round: 2 | 3 }
  | {
      type: 'candidate-submitted'
      agentId: 'Main' | 'B' | 'C'
      candidateId: string
      summary: string
      /** 正式候选的实质分析；可选以兼容旧事件消费者。scratch 临时路径不进入 UI 事件。 */
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
  /** 用户明确切换独立复杂任务；旧计划归档与新计划激活属于同一稳定 step。 */
  | {
      type: 'task-plan-replaced'
      previous: SupersededTaskPlan
      plan: ActiveTaskPlan
    }
  /** 共识事务取消/异常时，把任务卡恢复到协商开始前。 */
  | { type: 'task-plan-restored'; plan: TaskPlan | null }
  /** B/C 讨论过程流的包装（UI 按 agentId 归集到折叠卡片） */
  | { type: 'peer-event'; agentId: 'B' | 'C'; event: CoreEvent }

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
  /** 回滚到某写操作执行前的快照（仅空闲时） */
  | { type: 'restore-checkpoint'; toolUseId: string; scope: 'files' | 'files-and-chat' }
  /** 手动触发上下文压缩（仅空闲时） */
  | { type: 'compact' }
  /** 开关多 Agent 协商（需 Main/B/C 三者 key 齐备；纯聊天也可使用） */
  | { type: 'set-consensus'; enabled: boolean }

/** 事件回调签名：宿主注入给 core 的事件出口 */
export type CoreEventSink = (event: CoreEvent) => void
