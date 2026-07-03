import type { ModelMessage } from 'ai'
import type { ModelCapabilities } from '../providers/registry.ts'

/**
 * Token 计量（M2-d，文档一 §3.4）：不本地 tokenize——
 * 以最后一次 API usage 为基线 + 其后新消息的字符粗估（CJK 密度单独校准）。
 */

/** 粗估一段文本的 token 数：CJK 字符 /1.7，其余 /4（保守混合估计） */
export function estimateTextTokens(text: string): number {
  let cjk = 0
  for (const ch of text) {
    if (/[一-鿿぀-ヿ가-힯]/.test(ch)) cjk++
  }
  const other = text.length - cjk
  return Math.ceil(cjk / 1.7 + other / 4)
}

/** 粗估单条消息（含 tool call/result 的 JSON 开销） */
export function estimateMessageTokens(message: ModelMessage): number {
  if (typeof message.content === 'string') {
    return estimateTextTokens(message.content) + 4
  }
  let total = 4
  for (const part of message.content) {
    // 统一按 stringify 估：文本部分即正文，工具部分包含参数/结果 JSON
    total += estimateTextTokens(JSON.stringify(part))
  }
  return total
}

export interface TokenBaseline {
  /** 最后一次 API 响应的完整上下文大小（input+output tokens 真值） */
  usageTokens: number
  /** 该 usage 覆盖到的消息下标（其后的消息需粗估） */
  coveredMessageCount: number
}

/** 当前上下文估计 = usage 基线 + 基线之后新消息的粗估 */
export function estimateContextTokens(
  messages: ModelMessage[],
  baseline: TokenBaseline | null,
): number {
  if (!baseline) {
    return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
  }
  let total = baseline.usageTokens
  for (let i = baseline.coveredMessageCount; i < messages.length; i++) {
    total += estimateMessageTokens(messages[i]!)
  }
  return total
}

/** 自动压缩阈值：窗口 − 输出预留（摘要也要用）− buffer（小窗口 13k 起，大窗口 7%） */
export function autoCompactThreshold(capabilities: ModelCapabilities): number {
  const reservedOutput = Math.min(capabilities.maxOutput, 20_000)
  const buffer = Math.max(13_000, Math.round(capabilities.contextWindow * 0.07))
  return capabilities.contextWindow - reservedOutput - buffer
}
