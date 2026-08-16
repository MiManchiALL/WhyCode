import { asSchema, type ModelMessage, type ToolSet } from 'ai'
import type { ContextUsageInfo } from '../events.ts'
import type { ModelCapabilities } from '../providers/registry.ts'

/**
 * Token 计量（M2-d，文档一 §3.4）：不本地 tokenize——
 * 优先以最后一次 API usage 为基线并粗估后续增量；没有基线时估算完整请求组成。
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

/**
 * Provider 在消息块上附带的签名、加密推理载荷等协议元数据不是提示词正文。
 * 它们的真实影响由下一次 API usage 覆盖，字符长度不能作为本地 token 估算依据。
 */
function modelContentForEstimate(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const { providerOptions: _providerOptions, ...content } = value as Record<string, unknown>
  return content
}

function modelPartForEstimate(part: unknown): unknown {
  const content = modelContentForEstimate(part) as Record<string, unknown>
  if (content.type !== 'tool-result' || !content.output) return content
  return {
    ...content,
    output: modelContentForEstimate(content.output),
  }
}

/** 粗估单条消息（含 tool call/result 的可见 JSON 开销） */
export function estimateMessageTokens(message: ModelMessage): number {
  if (typeof message.content === 'string') {
    return estimateTextTokens(message.content) + 4
  }
  let total = 4
  for (const part of message.content) {
    if (
      part.type === 'image'
      || (part.type === 'file' && part.mediaType.startsWith('image/'))
    ) {
      // Base64 长度不是视觉 token；按 2048px PDF/截图的实测量级留更保守预算。
      total += 3_000
      continue
    }
    if (part.type === 'tool-result' && part.output.type === 'content') {
      total += estimateTextTokens(JSON.stringify({
        ...(modelPartForEstimate(part) as Record<string, unknown>),
        output: {
          ...(modelContentForEstimate(part.output) as Record<string, unknown>),
          value: [],
        },
      }))
      for (const item of part.output.value) {
        total += item.type === 'file' && item.mediaType.startsWith('image/')
          ? 3_000
          : estimateTextTokens(JSON.stringify(modelContentForEstimate(item)))
      }
      continue
    }
    // 统一按 stringify 估：文本部分即正文，工具部分包含名称、参数或结果 JSON。
    total += estimateTextTokens(JSON.stringify(modelPartForEstimate(part)))
  }
  return total
}

/** 粗估一组已经投影到 Provider 边界的消息。 */
export function estimateMessagesTokens(messages: readonly ModelMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
}

/**
 * 估算一次真实模型请求的固定开销。工具 schema 使用 AI SDK 将要发送的 JSON Schema；
 * 单个异常 schema 只退化为名称与说明估算，计量本身不能阻断模型请求。
 */
export async function estimateRequestContextOverhead(
  systemPrompt: string,
  tools: ToolSet | undefined,
): Promise<Pick<
  ContextUsageInfo['breakdown'],
  'systemPromptTokens' | 'toolTokens'
>> {
  const toolTokens = await Promise.all(
    Object.entries(tools ?? {}).map(async ([name, tool]) => {
      if (tool.type === 'provider') {
        return estimateTextTokens(JSON.stringify({ name, id: tool.id, args: tool.args }))
      }
      const description = typeof tool.description === 'string' ? tool.description : ''
      try {
        return estimateTextTokens(JSON.stringify({
          name,
          description,
          inputSchema: await asSchema(tool.inputSchema).jsonSchema,
        }))
      } catch {
        return estimateTextTokens(`${name}\n${description}`)
      }
    }),
  )
  return {
    systemPromptTokens: estimateTextTokens(systemPrompt),
    toolTokens: toolTokens.reduce((sum, tokens) => sum + tokens, 0),
  }
}

export interface TokenBaseline {
  /** 最后一次 API 响应的完整上下文大小（input+output tokens 真值） */
  usageTokens: number
  /** 该 usage 覆盖到的消息下标（其后的消息需粗估） */
  coveredMessageCount: number
}

/**
 * 当前请求压力的唯一口径：有 usage 时取 Provider 基线并估算其后增量；
 * 尚无 usage 时才以 System、工具目录等固定开销加全部消息粗估兜底。
 */
export function estimateContextTokens(
  messages: ModelMessage[],
  baseline: TokenBaseline | null,
  fallbackOverheadTokens = 0,
): number {
  if (!baseline) {
    return Math.max(0, fallbackOverheadTokens) + estimateMessagesTokens(messages)
  }
  let total = baseline.usageTokens
  for (let i = baseline.coveredMessageCount; i < messages.length; i++) {
    total += estimateMessageTokens(messages[i]!)
  }
  return total
}

/**
 * 自动压缩阈值：窗口 − 输出预留（摘要也要用）− buffer（小窗口 13k 起，大窗口 7%）。
 * maxOutput 是厂商允许的单次输出硬上限，不是普通请求的固定占用；预留封顶 20k，
 * 避免超长输出能力反而过早挤掉可用上下文，额外窗口 buffer 负责吸收估算误差。
 */
export function autoCompactThreshold(capabilities: ModelCapabilities): number {
  const reservedOutput = Math.min(capabilities.maxOutput, 20_000)
  const buffer = Math.max(13_000, Math.round(capabilities.contextWindow * 0.07))
  return capabilities.contextWindow - reservedOutput - buffer
}
