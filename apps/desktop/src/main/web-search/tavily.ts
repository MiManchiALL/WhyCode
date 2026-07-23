import {
  WebSearchError,
  type WebSearchHandler,
  type WebSearchRecency,
  type WebSearchRequest,
  type WebSearchResult,
} from '@whycode/core'
import type { TavilySearchDepth } from '../../shared/settings.ts'
import {
  postSearchJson,
  SEARCH_MAX_RESPONSE_BYTES,
  SEARCH_REQUEST_TIMEOUT_MS,
} from './http.ts'

const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search'

export interface TavilySearchOptions {
  getApiKey: () => string | undefined
  searchDepth: TavilySearchDepth
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>
  timeoutMs?: number
}

interface RankedTavilyResult {
  result: WebSearchResult
  score: number | null
  queryIndex: number
  resultIndex: number
}

type TavilyQueryOutcome =
  | { ok: true; query: string; results: RankedTavilyResult[] }
  | { ok: false; query: string; error: WebSearchError }

export function createTavilySearchHandler(options: TavilySearchOptions): WebSearchHandler {
  return async (request, abortSignal) => {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? SEARCH_REQUEST_TIMEOUT_MS)
    const signal = AbortSignal.any([abortSignal, timeoutSignal])
    const apiKey = options.getApiKey()?.trim()
    if (!apiKey) {
      throw new WebSearchError(
        '尚未配置 Tavily Search API key，请在“⚙ 连接 → 网页搜索”中配置',
      )
    }
    const maxResponseBytes = Math.floor(
      SEARCH_MAX_RESPONSE_BYTES / request.queries.length,
    )
    const outcomes = await Promise.all(request.queries.map(
      async (query, queryIndex): Promise<TavilyQueryOutcome> => {
        try {
          const response = await postSearchJson({
            endpoint: TAVILY_SEARCH_ENDPOINT,
            apiKey,
            body: tavilyRequestBody(request, query, options.searchDepth),
            serviceName: 'Tavily 搜索',
            signal,
            statusError,
            maxResponseBytes,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          })
          return {
            ok: true,
            query,
            results: parseSearchResponse(response, request.maxResults, queryIndex),
          }
        } catch (error) {
          return { ok: false, query, error: tavilySearchError(error) }
        }
      },
    ))
    if (abortSignal.aborted) throw new WebSearchError('网页搜索已取消')
    if (timeoutSignal.aborted) throw new WebSearchError('Tavily 网页搜索请求超时')

    const successes = outcomes.filter(
      (outcome): outcome is Extract<TavilyQueryOutcome, { ok: true }> => outcome.ok,
    )
    const failures = outcomes.filter(
      (outcome): outcome is Extract<TavilyQueryOutcome, { ok: false }> => !outcome.ok,
    )
    if (successes.length === 0 && failures.length > 0) throw failures[0]!.error
    const results = successes
      .flatMap((outcome) => outcome.results)
      .sort(compareRankedResults)
      .map((candidate) => candidate.result)
    return {
      results,
      ...(failures.length > 0 ? {
        failures: failures.map((failure) => ({
          query: failure.query,
          message: failure.error.message,
        })),
      } : {}),
    }
  }
}

function tavilyRequestBody(
  request: WebSearchRequest,
  query: string,
  searchDepth: TavilySearchDepth,
): Record<string, unknown> {
  return {
    query,
    max_results: request.maxResults,
    search_depth: searchDepth,
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    auto_parameters: true,
    ...(request.recency ? { time_range: tavilyTimeRange(request.recency) } : {}),
    ...(request.domains?.length ? { include_domains: request.domains } : {}),
  }
}

function tavilyTimeRange(recency: WebSearchRecency): Exclude<WebSearchRecency, 'hour'> {
  return recency === 'hour' ? 'day' : recency
}

function statusError(status: number): WebSearchError {
  if (status === 401 || status === 403) {
    return new WebSearchError('Tavily Search API key 无效或没有搜索权限')
  }
  if (status === 402 || status === 432 || status === 433) {
    return new WebSearchError('Tavily Search API 账户额度或计划限制已达到')
  }
  if (status === 429) return new WebSearchError('Tavily 搜索请求过于频繁')
  if (status === 400 || status === 422) {
    return new WebSearchError('Tavily 拒绝了当前搜索请求')
  }
  if (status >= 500) return new WebSearchError('Tavily 网页搜索服务暂时不可用')
  return new WebSearchError(`Tavily 网页搜索失败（HTTP ${status}）`)
}

function parseSearchResponse(
  value: unknown,
  maxResults: number,
  queryIndex: number,
): RankedTavilyResult[] {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new WebSearchError('Tavily 搜索响应格式不受支持')
  }
  const results = value.results.flatMap((item, resultIndex) => {
    const candidate = parseResult(item, queryIndex, resultIndex)
    return candidate ? [candidate] : []
  })
  if (value.results.length > 0 && results.length === 0) {
    throw new WebSearchError('Tavily 搜索结果格式不受支持')
  }
  return results.sort(compareRankedResults).slice(0, maxResults)
}

function parseResult(
  value: unknown,
  queryIndex: number,
  resultIndex: number,
): RankedTavilyResult | null {
  if (
    !isRecord(value)
    || typeof value.title !== 'string'
    || typeof value.url !== 'string'
    || typeof value.content !== 'string'
  ) return null
  return {
    result: {
      title: value.title,
      url: value.url,
      snippet: value.content,
      ...(typeof value.published_date === 'string'
        ? { publishedDate: value.published_date }
        : {}),
    },
    score: typeof value.score === 'number' && Number.isFinite(value.score)
      ? value.score
      : null,
    queryIndex,
    resultIndex,
  }
}

function compareRankedResults(
  left: RankedTavilyResult,
  right: RankedTavilyResult,
): number {
  if (left.score !== right.score) {
    if (left.score === null) return 1
    if (right.score === null) return -1
    return right.score - left.score
  }
  return left.queryIndex - right.queryIndex || left.resultIndex - right.resultIndex
}

function tavilySearchError(error: unknown): WebSearchError {
  return error instanceof WebSearchError
    ? error
    : new WebSearchError('无法连接 Tavily 网页搜索服务')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
