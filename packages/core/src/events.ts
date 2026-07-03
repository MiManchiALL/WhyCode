/**
 * CoreEvent / CoreCommand 协议 —— core 与宿主（Electron Main / 未来的宠物桥）之间的唯一边界。
 *
 * 硬性约束：
 * - 所有类型必须 JSON-safe（可 structuredClone / JSON.stringify），未来跨进程传输不改协议。
 * - 新增事件只允许追加 type，不允许修改已有字段语义（宠物侧会依赖子集）。
 * - 与 docs/02-技术栈与架构.md §6 保持同步，改这里必须改文档。
 */

/** 单轮对话的 token 用量与成本统计 */
export interface UsageInfo {
  inputTokens: number
  outputTokens: number
  /** 命中缓存读取的 token 数（provider 支持时） */
  cachedInputTokens: number
  /** 累计估算成本（美元） */
  costUsd: number
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
  | { type: 'text-delta'; text: string }
  | { type: 'thinking-delta'; text: string }
  | { type: 'thinking-end'; durationMs: number }
  | { type: 'tool-start'; toolUseId: string; toolName: string; input: unknown }
  | { type: 'tool-progress'; toolUseId: string; output: string }
  | { type: 'tool-end'; toolUseId: string; result: unknown; isError: boolean }
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
  // --- steering（M2-a）：运行中插话 ---
  | { type: 'message-queued'; id: string; text: string }
  | { type: 'message-injected'; id: string; text: string }
  /** 中断后把排队文本还给输入框（不静默丢弃） */
  | { type: 'queue-restored'; text: string }
  // --- 检查点（M2-c）---
  /** 写类工具执行前的快照已建立（hash 供回滚） */
  | { type: 'checkpoint-created'; toolUseId: string; hash: string }
  | {
      type: 'checkpoint-restored'
      toolUseId: string
      /** 所属 turn（files-and-chat 回滚时 UI 据此截断到 turn 起点） */
      turnId: string
      scope: 'files' | 'files-and-chat'
      ok: boolean
      error?: string
    }
  /** 检查点功能被禁用（项目目录不适用/git 缺失/超时），只提示一次 */
  | { type: 'checkpoint-disabled'; reason: string }
  // --- 上下文压缩（M2-d）---
  | {
      type: 'context-compacted'
      /** micro = 仅清理旧工具输出；full = 摘要压缩 */
      level: 'micro' | 'full'
      preTokens: number
      postTokens: number
    }

export type StopReason = 'completed' | 'aborted' | 'max-turns' | 'error'

/** 宿主 → core 的命令 */
export type CoreCommand =
  | {
      type: 'user-message'
      text: string
      /** true = 立即插话：打断当前步骤马上注入（Claude Code 的 now 语义）；默认排队到步骤间 */
      urgent?: boolean
      /** 附件文件路径（宠物文件投递复用此通道） */
      attachmentPaths?: string[]
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
  | { type: 'set-permission-mode'; mode: 'readonly' | 'default' | 'acceptEdits' | 'auto' }
  /** 回滚到某写操作执行前的快照（仅空闲时） */
  | { type: 'restore-checkpoint'; toolUseId: string; scope: 'files' | 'files-and-chat' }

/** 事件回调签名：宿主注入给 core 的事件出口 */
export type CoreEventSink = (event: CoreEvent) => void
