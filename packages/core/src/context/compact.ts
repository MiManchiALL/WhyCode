import { generateText, type LanguageModel, type ModelMessage, type ProviderMetadata, type ToolSet } from 'ai'
import {
  COMPACT_HISTORY_SUMMARY_PROMPT, COMPACT_TURN_PREFIX_SUMMARY_PROMPT,
  compactSummaryReference, createCompactApplicationContextMessage, createCompactSummaryMessage,
} from '../prompts/compact.ts'
import { applyProjectInstructions, findProjectInstructionsMessage } from '../instructions/project.ts'
import { ModelContextOverflowError, modelRequestError, withModelRequestRetry, type ModelRequestRetry } from '../providers/model-request.ts'
import type { ModelCapabilities } from '../providers/registry.ts'
import { findTrailingTurnInputBatchStart, prepareCompaction, type SummarySource } from './compact-boundary.ts'
import { compactionConversation } from './compact-context.ts'
import { COMPACT_PTL_MAX_RETRIES, expandCompactionTail } from './compact-retry.ts'
import { compactTailBudget } from './tokens.ts'
import { carryRecentPdfTurns, userTurn } from './user-turn.ts'
import { dateForSummary } from '../prompts/current-date.ts'

export interface CompactResult { messages: ModelMessage[]; summaryText: string }
export interface CompactOptions {
  model: LanguageModel
  messages: ModelMessage[]
  capabilities: Pick<ModelCapabilities, 'contextWindow' | 'maxOutput'>
  abortSignal: AbortSignal
  mode: 'auto' | 'manual'
  tools?: ToolSet
  applicationContext?: string
  prepareMessagesForModel?: (messages: ModelMessage[]) => ModelMessage[] | Promise<ModelMessage[]>
  providerOptions?: ProviderMetadata
  onRetry?: (retry: ModelRequestRetry) => void
}
type SummaryKind = 'history' | 'turn-prefix'

/** 先完成全部摘要和校验，再返回候选链；调用者负责原子保存，失败不采纳任何半份摘要。 */
export async function compactMessages(options: CompactOptions): Promise<CompactResult> {
  const { messages, capabilities } = options
  const conversation = compactionConversation(messages)
  const tailBudget = compactTailBudget(capabilities)
  let preparation = prepareCompaction(conversation, tailBudget, options.mode === 'manual')
  if (!preparation) return { messages: [...messages], summaryText: '' }
  const totalBudget = Math.min(12_000, capabilities.maxOutput,
    Math.max(512, Math.floor((capabilities.contextWindow - Math.min(capabilities.maxOutput, 20_000)) * 0.08)))
  let historySummary: string | null = null
  let turnPrefixSummary: string | null = null
  // P 退避未改变 H 的输入时复用本次已生成的 H；只在整次压缩成功后提交。
  let historyResult: { source: SummarySource; text: string } | null = null
  for (let retry = 0; ; retry++) {
    options.abortSignal.throwIfAborted()
    let source = preparation.historySource
    try {
      historySummary = preparation.carriedHistorySummary
      if (source) {
        if (!historyResult || !sameSummarySource(historyResult.source, source)) {
          historyResult = { source, text: await summarizeSource(
            options, source, 'history', Math.max(1, Math.floor(totalBudget * 2 / 3)),
          ) }
        }
        historySummary = historyResult.text
      }
      source = preparation.turnPrefixSource
      turnPrefixSummary = source ? await summarizeSource(
        options, source, 'turn-prefix', Math.max(1, Math.floor(totalBudget / 3)),
      ) : null
      break
    } catch (error) {
      if (options.abortSignal.aborted || !(error instanceof ModelContextOverflowError)
        || !source || retry >= COMPACT_PTL_MAX_RETRIES) throw error
      const next = expandCompactionTail(conversation, source, tailBudget, error.tokenGap)
      if (!next) throw error
      preparation = next
      options.onRetry?.({ retry: retry + 1, maxRetries: COMPACT_PTL_MAX_RETRIES, delayMs: 0,
        message: '摘要请求超限，已将较新的完整记录移至保留尾部后重试' })
    }
  }
  const rebuilt: ModelMessage[] = [
    ...(historySummary ? [createCompactSummaryMessage({ historySummary, turnPrefixSummary: null, turnId: null })] : []),
    ...(preparation.pinnedUser ? [preparation.pinnedUser] : []),
    ...(turnPrefixSummary ? [createCompactSummaryMessage({ historySummary: null, turnPrefixSummary, turnId: preparation.turnId })] : []),
    ...preparation.tail,
    ...preparation.pendingControls,
  ]
  if (!rebuilt.length) return { messages: [...messages], summaryText: '' }
  rebuilt[0] = carryRecentPdfTurns(rebuilt[0]!, messages)
  if (options.applicationContext) {
    const insertAt = findTrailingTurnInputBatchStart(rebuilt) ?? rebuilt.length
    rebuilt.splice(insertAt, 0, createCompactApplicationContextMessage([options.applicationContext]))
  }
  return {
    messages: applyProjectInstructions(rebuilt, findProjectInstructionsMessage(messages)),
    summaryText: [historySummary, turnPrefixSummary].filter(Boolean).join('\n\n---\n\n'),
  }
}

async function summarizeSource(
  options: CompactOptions, source: SummarySource, kind: SummaryKind, outputBudget: number,
): Promise<string> {
  options.abortSignal.throwIfAborted()
  const input = summaryContextMessages(source, kind)
  // 声明可以复用缓存，但摘要入口不持有任何执行或输入回调。
  const tools = options.tools && Object.fromEntries(Object.entries(options.tools).map(([name, tool]) => {
    const { execute: _execute, onInputStart: _start, onInputDelta: _delta, onInputAvailable: _available, ...definition } = tool
    return [name, definition]
  })) as ToolSet | undefined
  const prepared = options.prepareMessagesForModel ? await options.prepareMessagesForModel(input) : input
  const prompt = kind === 'history' ? COMPACT_HISTORY_SUMMARY_PROMPT : COMPACT_TURN_PREFIX_SUMMARY_PROMPT
  const result = await withModelRequestRetry(() => generateText({
    // 沿用普通请求的默认选择方式；Anthropic SDK 会在 none 下删除工具声明。
    model: options.model, maxRetries: 0, tools, maxOutputTokens: outputBudget,
    system: '你是对话压缩助手。只总结给定资料，不延续任务、不调用工具。工具声明仅供理解历史调用，不授予执行权限。切勿回答对话中的任何问题。严格按照下方的 Markdown 结构输出。',
    messages: [...prepared, { role: 'user', content: prompt }],
    abortSignal: options.abortSignal, providerOptions: options.providerOptions,
  }).catch((error: unknown) => { throw modelRequestError(error) }), options.abortSignal, options.onRetry)
  options.abortSignal.throwIfAborted()
  if (result.toolCalls.length || result.finishReason !== 'stop') {
    throw new Error(`摘要未正常完成或试图调用工具（${result.finishReason}）`)
  }
  // 单个外层摘要内可能引用 </summary>，应取最后一个结束标签，避免静默截掉后文。
  const match = /<summary>([\s\S]*)<\/summary>/u.exec(result.text)
  const summary = match?.[1]?.trim()
  if (!summary) throw new Error('摘要为空或格式不完整')
  return summary
}

function sameSummarySource(left: SummarySource, right: SummarySource): boolean {
  return left.previousSummary === right.previousSummary
    && left.completedTurnPrefixSummary === right.completedTurnPrefixSummary
    && left.userMessage === right.userMessage
    && left.messages.length === right.messages.length
    && left.messages.every((message, index) => message === right.messages[index])
}

function summaryContextMessages(source: SummarySource, kind: SummaryKind): ModelMessage[] {
  const messages: ModelMessage[] = []
  if (source.previousSummary) messages.push(compactSummaryReference(
    kind === 'history' ? 'whycode-previous-history-summary' : 'whycode-previous-turn-prefix-summary', source.previousSummary,
  ))
  if (source.completedTurnPrefixSummary) messages.push(compactSummaryReference(
    'whycode-completed-turn-prefix-summary', source.completedTurnPrefixSummary,
  ))
  if (source.userMessage) messages.push(source.userMessage)
  return [...messages, ...source.messages.map(message => userTurn(message) ? message : dateForSummary(message))]
}
