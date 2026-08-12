import {
  generateText,
  type LanguageModel,
  type ModelMessage,
  type ProviderMetadata,
} from 'ai'
import { readFile } from 'node:fs/promises'
import {
  COMPACT_HISTORY_SUMMARY_PROMPT,
  COMPACT_TURN_PREFIX_SUMMARY_PROMPT,
  compactSummaryReference,
  createCompactApplicationContextMessage,
  createCompactSummaryMessage,
} from '../prompts/compact.ts'
import {
  applyProjectInstructions,
  findProjectInstructionsMessage,
} from '../instructions/project.ts'
import {
  findTrailingTurnInputBatchStart,
  prepareCompaction,
  type SummarySource,
} from './compact-boundary.ts'
import { estimateTextTokens } from './tokens.ts'

const REINJECT_MAX_FILES = 5
const REINJECT_TOKEN_BUDGET = 50_000
const REINJECT_MAX_TOKENS_PER_FILE = 5_000

export interface CompactResult {
  messages: ModelMessage[]
  summaryText: string
}

type SummaryKind = 'history' | 'turn-prefix'

/** 调用当前模型生成一种摘要（关工具），剥掉可选的 analysis 草稿。 */
async function summarize(
  model: LanguageModel,
  messages: ModelMessage[],
  kind: SummaryKind,
  abortSignal: AbortSignal,
  providerOptions?: ProviderMetadata,
): Promise<string> {
  const prompt = kind === 'history'
    ? COMPACT_HISTORY_SUMMARY_PROMPT
    : COMPACT_TURN_PREFIX_SUMMARY_PROMPT
  const result = await generateText({
    model,
    system: '你是对话压缩助手。忠实总结给定范围，不延续任务，不调用工具。',
    messages: [...messages, { role: 'user', content: prompt }],
    abortSignal,
    providerOptions,
  })
  const match = /<summary>([\s\S]*?)(<\/summary>|$)/u.exec(result.text)
  const summary = (match
    ? match[1]!
    : result.text.replace(/<analysis>[\s\S]*?<\/analysis>/u, '')
  ).trim()
  if (!summary) throw new Error(`${kind === 'history' ? '历史' : 'turn 前缀'}摘要为空`)
  return summary
}

/** 重注入最近读过的文件（新鲜内容重读，防压缩后失忆）。 */
async function buildFileReinjection(
  recentReadFiles: { path: string; readAt: number }[],
): Promise<string | null> {
  const sorted = [...recentReadFiles].sort((a, b) => b.readAt - a.readAt).slice(0, REINJECT_MAX_FILES)
  let budget = REINJECT_TOKEN_BUDGET
  const sections: string[] = []
  for (const file of sorted) {
    const content = await readFile(file.path, 'utf-8').catch(() => null)
    if (content === null) continue
    let text = content
    while (estimateTextTokens(text) > REINJECT_MAX_TOKENS_PER_FILE) {
      text = `${text.slice(0, Math.floor(text.length * 0.8))}\n[已截断]`
    }
    const cost = estimateTextTokens(text)
    if (cost > budget) continue
    budget -= cost
    sections.push(`### ${file.path}\n${text}`)
  }
  return sections.length > 0
    ? `压缩前最近读过的文件（当前最新内容）：\n\n${sections.join('\n\n')}`
    : null
}

/** 执行完整压缩并重建当前模型消息链。 */
export async function compactMessages(
  model: LanguageModel,
  messages: ModelMessage[],
  recentReadFiles: { path: string; readAt: number }[],
  abortSignal: AbortSignal,
  applicationContext?: string,
  prepareMessagesForModel?: (
    messages: ModelMessage[],
  ) => ModelMessage[] | Promise<ModelMessage[]>,
  providerOptions?: ProviderMetadata,
): Promise<CompactResult> {
  const projectInstructions = findProjectInstructionsMessage(messages)
  const conversationMessages = applyProjectInstructions(messages, null)
  const preparation = prepareCompaction(conversationMessages)
  if (!preparation) {
    return {
      messages: applyProjectInstructions(conversationMessages, projectInstructions),
      summaryText: '',
    }
  }

  let historySummary = preparation.carriedHistorySummary
  if (preparation.historySource) {
    historySummary = await summarizeSource(
      model,
      preparation.historySource,
      'history',
      projectInstructions,
      abortSignal,
      prepareMessagesForModel,
      providerOptions,
    )
  }
  const turnPrefixSummary = preparation.turnPrefixSource
    ? await summarizeSource(
        model,
        preparation.turnPrefixSource,
        'turn-prefix',
        projectInstructions,
        abortSignal,
        prepareMessagesForModel,
        providerOptions,
      )
    : null

  if (!historySummary && !turnPrefixSummary) {
    return {
      messages: applyProjectInstructions(conversationMessages, projectInstructions),
      summaryText: '',
    }
  }
  const rebuilt: ModelMessage[] = [
    createCompactSummaryMessage({ historySummary, turnPrefixSummary }),
    ...preparation.tail,
  ]
  await injectApplicationContext(rebuilt, recentReadFiles, applicationContext)
  return {
    messages: applyProjectInstructions(rebuilt, projectInstructions),
    summaryText: [historySummary, turnPrefixSummary].filter(Boolean).join('\n\n---\n\n'),
  }
}

async function summarizeSource(
  model: LanguageModel,
  source: SummarySource,
  kind: SummaryKind,
  projectInstructions: ModelMessage | null,
  abortSignal: AbortSignal,
  prepareMessagesForModel?: (
    messages: ModelMessage[],
  ) => ModelMessage[] | Promise<ModelMessage[]>,
  providerOptions?: ProviderMetadata,
): Promise<string> {
  const summaryContext = summaryContextMessages(source, kind)
  const input = projectInstructions
    ? [projectInstructions, ...summaryContext]
    : summaryContext
  const prepared = prepareMessagesForModel
    ? await prepareMessagesForModel(input)
    : input
  return summarize(model, prepared, kind, abortSignal, providerOptions)
}

function summaryContextMessages(
  source: SummarySource,
  kind: SummaryKind,
): ModelMessage[] {
  const messages: ModelMessage[] = []
  if (source.previousSummary) {
    const tag = kind === 'history'
      ? 'whycode-previous-history-summary'
      : 'whycode-previous-turn-prefix-summary'
    messages.push(compactSummaryReference(tag, source.previousSummary))
  }
  if (source.completedTurnPrefixSummary) {
    messages.push(compactSummaryReference(
      'whycode-completed-turn-prefix-summary',
      source.completedTurnPrefixSummary,
    ))
  }
  return [...messages, ...source.messages]
}

async function injectApplicationContext(
  messages: ModelMessage[],
  recentReadFiles: { path: string; readAt: number }[],
  applicationContext?: string,
): Promise<void> {
  const sections = [
    await buildFileReinjection(recentReadFiles),
    applicationContext,
  ].filter((section): section is string => Boolean(section))
  if (sections.length === 0) return
  const internalMessage = createCompactApplicationContextMessage(sections)
  const insertAt = findTrailingTurnInputBatchStart(messages) ?? messages.length
  messages.splice(insertAt, 0, internalMessage)
}
