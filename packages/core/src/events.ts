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
      /** 写文件类工具附带的变更预览（unified diff 文本） */
      diff?: string
    }
  | { type: 'turn-end'; turnId: string; usage: UsageInfo; stopReason: StopReason }
  | { type: 'agent-status'; status: AgentStatus }
  | { type: 'error'; message: string; recoverable: boolean }

export type StopReason = 'completed' | 'aborted' | 'max-turns' | 'error'

/** 宿主 → core 的命令 */
export type CoreCommand =
  | {
      type: 'user-message'
      text: string
      /** 附件文件路径（宠物文件投递复用此通道） */
      attachmentPaths?: string[]
    }
  | { type: 'approval-response'; requestId: string; approved: boolean }
  | { type: 'abort' }
  | { type: 'set-model'; modelId: string }

/** 事件回调签名：宿主注入给 core 的事件出口 */
export type CoreEventSink = (event: CoreEvent) => void
