import { generateText, type LanguageModel, type ModelMessage } from 'ai'
import { readFile } from 'node:fs/promises'
import { estimateMessageTokens, estimateTextTokens } from './tokens.ts'
import {
  COMPACT_CONTINUATION_PREFIX,
  COMPACT_CONTINUATION_SUFFIX,
  COMPACT_SUMMARY_PROMPT,
} from '../prompts/compact.ts'
import { findPendingTurnAbortedIndex } from '../session/interruption.ts'
import { findPendingUserQuestionIndex } from '../tasks/answer-resume.ts'

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
 * 选择保留的尾部起点：从末尾向前累积到 ≥10k tokens 且 ≥5 条真实文本消息（40k 软上限），
 * 再回退到最近的 user 消息边界（保证不切断 assistant tool-call 与 tool result 配对）。
 */
export function pickTailStart(messages: ModelMessage[]): number {
  let tokens = 0
  let textMessages = 0
  let start = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    const t = estimateMessageTokens(messages[i]!)
    if (tokens + t > KEEP_TAIL_MAX_TOKENS && textMessages >= KEEP_TAIL_MIN_TEXT_MESSAGES) break
    tokens += t
    if (isConversationTextMessage(messages[i]!)) textMessages++
    start = i
    if (tokens >= KEEP_TAIL_MIN_TOKENS && textMessages >= KEEP_TAIL_MIN_TEXT_MESSAGES) break
  }
  // 回退到包含当前起点的真实 user turn，避免切断 assistant tool-call/result。
  for (let i = Math.min(start, messages.length - 1); i >= 0; i--) {
    if (isRealUserMessage(messages[i]!)) return i
  }
  return 0
}

/** 摘要前缀终点；尚未消费的中断边界及其后新消息必须逐字保留。 */
export function pickSummaryEnd(messages: ModelMessage[]): number {
  const tailStart = pickTailStart(messages)
  const defaultEnd = tailStart === 0 ? messages.length : tailStart
  const protectedIndexes = [
    findPendingTurnAbortedIndex(messages),
    findPendingUserQuestionIndex(messages),
    trailingUserBatchStart(messages),
  ].filter((index): index is number => index !== null)
  return protectedIndexes.length === 0 ? defaultEnd : Math.min(defaultEnd, ...protectedIndexes)
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
  return `压缩前最近读过的文件（当前最新内容）：\n\n${sections.join('\n\n')}`
}

/** 执行完整压缩：摘要 + 尾部保留 + 文件重注入，返回重建后的消息数组 */
export async function compactMessages(
  model: LanguageModel,
  messages: ModelMessage[],
  recentReadFiles: { path: string; readAt: number }[],
  abortSignal: AbortSignal,
  applicationContext?: string,
  prepareMessagesForModel?: (
    messages: ModelMessage[],
  ) => ModelMessage[] | Promise<ModelMessage[]>,
): Promise<CompactResult> {
  // 尾部起点为 0 = 全部历史都在尾部预算内，此时「摘要+全量尾部」只会更大——退化为纯摘要替换
  const effectiveTailStart = pickSummaryEnd(messages)
  if (effectiveTailStart === 0) return { messages: [...messages], summaryText: '' }
  const toSummarize = messages.slice(0, effectiveTailStart)
  const tail = messages.slice(effectiveTailStart)
  const preparedMessages = prepareMessagesForModel
    ? await prepareMessagesForModel(toSummarize)
    : toSummarize
  const summaryText = await summarize(model, preparedMessages, abortSignal)

  const rebuilt: ModelMessage[] = [
    {
      role: 'user',
      content: COMPACT_CONTINUATION_PREFIX + summaryText + COMPACT_CONTINUATION_SUFFIX,
    },
    ...tail,
  ]
  const internalSections = [
    await buildFileReinjection(recentReadFiles),
    applicationContext,
  ].filter((section): section is string => Boolean(section))
  if (internalSections.length > 0) {
    const internalMessage: ModelMessage = {
      role: 'user',
      content: ['<system-reminder>', ...internalSections, '</system-reminder>'].join('\n\n'),
    }
    let insertAt = rebuilt.length
    while (insertAt > 0 && isRealUserMessage(rebuilt[insertAt - 1]!)) insertAt--
    rebuilt.splice(insertAt, 0, internalMessage)
  }
  return { messages: rebuilt, summaryText }
}

function isConversationTextMessage(message: ModelMessage): boolean {
  if (message.role === 'tool') return false
  if (isInternalMessage(message)) return false
  return modelMessageText(message).trim().length > 0
}

function trailingUserBatchStart(messages: ModelMessage[]): number | null {
  if (messages.length === 0 || !isRealUserMessage(messages.at(-1)!)) return null
  let start = messages.length - 1
  while (start > 0 && isRealUserMessage(messages[start - 1]!)) start--
  return start
}

function isRealUserMessage(message: ModelMessage): boolean {
  return message.role === 'user' && !isInternalMessage(message)
}

function isInternalMessage(message: ModelMessage): boolean {
  if (message.role !== 'user') return false
  const text = modelMessageText(message).trimStart()
  return text.startsWith('<system-reminder>')
}

function modelMessageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
}
