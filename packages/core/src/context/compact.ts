import { generateText, type LanguageModel, type ModelMessage } from 'ai'
import { readFile } from 'node:fs/promises'
import { estimateMessageTokens, estimateTextTokens } from './tokens.ts'
import { COMPACT_SUMMARY_PROMPT, COMPACT_CONTINUATION_PREFIX } from '../prompts/compact.ts'

/**
 * 全量摘要压缩（M2-d 第二级）。重建顺序：摘要 → 保留尾部 → 重注入最近读过的文件。
 */

const KEEP_TAIL_MIN_TOKENS = 10_000
const KEEP_TAIL_MAX_TOKENS = 40_000
const KEEP_TAIL_MIN_TEXT_MESSAGES = 5
const REINJECT_MAX_FILES = 5
const REINJECT_TOKEN_BUDGET = 50_000
const REINJECT_MAX_TOKENS_PER_FILE = 5_000

export interface CompactResult {
  messages: ModelMessage[]
  summaryText: string
}

/**
 * 选择保留的尾部起点：从末尾向前累积到 ≥10k tokens 且 ≥5 条含文本消息（上限 40k），
 * 再回退到最近的 user 消息边界（保证不切断 assistant tool-call 与 tool result 配对）。
 */
export function pickTailStart(messages: ModelMessage[]): number {
  let tokens = 0
  let textMessages = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateMessageTokens(messages[i]!)
    if (tokens + t > KEEP_TAIL_MAX_TOKENS) break
    tokens += t
    const m = messages[i]!
    if (
      m.role !== 'tool' &&
      (typeof m.content === 'string' ||
        m.content.some((p) => p.type === 'text' && p.text.trim()))
    ) {
      textMessages++
    }
    start = i
    if (tokens >= KEEP_TAIL_MIN_TOKENS && textMessages >= KEEP_TAIL_MIN_TEXT_MESSAGES) break
  }
  // 回退到 user 消息边界（turn 起点），天然不会切断工具配对
  while (start < messages.length && messages[start]!.role !== 'user') start++
  return start
}

/** 调用当前模型生成摘要（关工具），剥掉 <analysis> 草稿 */
export async function summarize(
  model: LanguageModel,
  messages: ModelMessage[],
  abortSignal: AbortSignal,
): Promise<string> {
  const result = await generateText({
    model,
    system: '你是一个负责总结对话的助手。',
    messages: [...messages, { role: 'user', content: COMPACT_SUMMARY_PROMPT }],
    abortSignal,
  })
  const text = result.text
  const summaryMatch = /<summary>([\s\S]*?)(<\/summary>|$)/.exec(text)
  return (summaryMatch ? summaryMatch[1]! : text.replace(/<analysis>[\s\S]*?<\/analysis>/, '')).trim()
}

/** 重注入最近读过的文件（新鲜内容重读，防「压缩后失忆」） */
async function buildFileReinjection(
  recentReadFiles: { path: string; readAt: number }[],
): Promise<string | null> {
  const sorted = [...recentReadFiles].sort((a, b) => b.readAt - a.readAt).slice(0, REINJECT_MAX_FILES)
  let budget = REINJECT_TOKEN_BUDGET
  const sections: string[] = []
  for (const f of sorted) {
    const content = await readFile(f.path, 'utf-8').catch(() => null)
    if (content === null) continue
    let text = content
    while (estimateTextTokens(text) > REINJECT_MAX_TOKENS_PER_FILE) {
      text = text.slice(0, Math.floor(text.length * 0.8)) + '\n[已截断]'
    }
    const cost = estimateTextTokens(text)
    if (cost > budget) continue
    budget -= cost
    sections.push(`### ${f.path}\n${text}`)
  }
  if (sections.length === 0) return null
  return `<system-reminder>\n压缩前最近读过的文件（当前最新内容，供继续工作参考）：\n\n${sections.join('\n\n')}\n</system-reminder>`
}

/** 执行完整压缩：摘要 + 尾部保留 + 文件重注入，返回重建后的消息数组 */
export async function compactMessages(
  model: LanguageModel,
  messages: ModelMessage[],
  recentReadFiles: { path: string; readAt: number }[],
  abortSignal: AbortSignal,
): Promise<CompactResult> {
  // 尾部起点为 0 = 全部历史都在尾部预算内，此时「摘要+全量尾部」只会更大——退化为纯摘要替换
  const tailStart = pickTailStart(messages)
  const effectiveTailStart = tailStart === 0 ? messages.length : tailStart
  const toSummarize = messages.slice(0, effectiveTailStart)
  const tail = messages.slice(effectiveTailStart)
  const summaryText = await summarize(model, toSummarize, abortSignal)

  const rebuilt: ModelMessage[] = [
    { role: 'user', content: COMPACT_CONTINUATION_PREFIX + summaryText },
    ...tail,
  ]
  const reinjection = await buildFileReinjection(recentReadFiles)
  if (reinjection) {
    rebuilt.push({ role: 'user', content: reinjection })
  }
  return { messages: rebuilt, summaryText }
}
