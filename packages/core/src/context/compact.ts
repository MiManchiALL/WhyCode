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
import { COMPACT_PTL_MAX_RETRIES, trimSummaryInput } from './compact-retry.ts'
import { compactTailBudget, estimateTextTokens } from './tokens.ts'
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
  const preparation = prepareCompaction(compactionConversation(messages),
    compactTailBudget(capabilities), options.mode === 'manual')
  if (!preparation) return { messages: [...messages], summaryText: '' }
  const totalBudget = Math.min(12_000, capabilities.maxOutput,
    Math.max(512, Math.floor((capabilities.contextWindow - Math.min(capabilities.maxOutput, 20_000)) * 0.08)))
  let historySummary = preparation.carriedHistorySummary
  if (preparation.historySource) historySummary = await summarizeSource(
    options, preparation.historySource, 'history', Math.max(1, Math.floor(totalBudget * 2 / 3)),
  )
  const turnPrefixSummary = preparation.turnPrefixSource ? await summarizeSource(
    options, preparation.turnPrefixSource, 'turn-prefix', Math.max(1, Math.floor(totalBudget / 3)),
  ) : null
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
  let input = summaryContextMessages(source, kind)
  let omitted = false
  // 声明可以复用缓存，但摘要入口不持有任何执行或输入回调。
  const tools = options.tools && Object.fromEntries(Object.entries(options.tools).map(([name, tool]) => {
    const { execute: _execute, onInputStart: _start, onInputDelta: _delta, onInputAvailable: _available, ...definition } = tool
    return [name, definition]
  })) as ToolSet | undefined
  for (let retry = 0; ; retry++) {
    options.abortSignal.throwIfAborted()
    const prepared = options.prepareMessagesForModel ? await options.prepareMessagesForModel(input) : input
    const prompt = kind === 'history' ? COMPACT_HISTORY_SUMMARY_PROMPT : COMPACT_TURN_PREFIX_SUMMARY_PROMPT
    try {
      const result = await withModelRequestRetry(() => generateText({
        model: options.model, maxRetries: 0, tools, toolChoice: 'none', maxOutputTokens: outputBudget,
        system: '你是对话压缩助手。只总结给定资料，不延续任务、不调用工具。工具声明仅供理解历史调用，不授予执行权限。',
        messages: [...prepared, { role: 'user', content: prompt
          + (omitted ? '\n因上下文超限，最老的部分完整历史已从摘要输入移除；不得臆造缺失内容。' : '') }],
        abortSignal: options.abortSignal, providerOptions: options.providerOptions,
      }).catch((error: unknown) => { throw modelRequestError(error) }), options.abortSignal, options.onRetry)
      options.abortSignal.throwIfAborted()
      if (result.toolCalls.length || result.finishReason !== 'stop') {
        throw new Error(`摘要未正常完成或试图调用工具（${result.finishReason}）`)
      }
      const match = /^\s*<summary>([\s\S]*?)<\/summary>\s*$/u.exec(result.text)
      const summary = match?.[1]?.trim()
      if (!summary || estimateTextTokens(summary) > outputBudget) throw new Error('摘要为空、格式不完整或超过输出预算')
      return omitted ? `[部分最早历史因摘要请求超限未能保留。]\n${summary}` : summary
    } catch (error) {
      if (options.abortSignal.aborted || !(error instanceof ModelContextOverflowError) || retry >= COMPACT_PTL_MAX_RETRIES) throw error
      const trimmed = trimSummaryInput(input, error.tokenGap)
      if (!trimmed) throw error
      input = trimmed
      omitted = true
      options.onRetry?.({ retry: retry + 1, maxRetries: COMPACT_PTL_MAX_RETRIES, delayMs: 0,
        message: '摘要请求超限，已按安全边界移除最老历史后重试' })
    }
  }
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
