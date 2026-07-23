import {
  WebSearchError,
  type WebSearchHandler,
  type WebSearchRequest,
  type WebSearchResponse,
  type WebSearchResult,
} from '@whycode/core'
import {
  postSearchJson,
  SEARCH_REQUEST_TIMEOUT_MS,
} from './http.ts'

const PERPLEXITY_SEARCH_ENDPOINT = 'https://api.perplexity.ai/search'

export interface PerplexitySearchOptions {
  getApiKey: () => string | undefined
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>
  timeoutMs?: number
}

export function createPerplexitySearchHandler(
  options: PerplexitySearchOptions,
): WebSearchHandler {
  return async (request, abortSignal) => {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? SEARCH_REQUEST_TIMEOUT_MS)
    const signal = AbortSignal.any([abortSignal, timeoutSignal])
    try {
      const apiKey = options.getApiKey()?.trim()
      if (!apiKey) {
        throw new WebSearchError(
          '尚未配置 Perplexity Search API key，请在“⚙ 连接 → 网页搜索”中配置',
        )
      }
      const response = await postSearchJson({
        endpoint: PERPLEXITY_SEARCH_ENDPOINT,
        apiKey,
        body: perplexityRequestBody(request),
        serviceName: 'Perplexity 搜索',
        signal,
        statusError,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      })
      return parseSearchResponse(
        response,
        request.maxResults * request.queries.length,
      )
    } catch (error) {
      if (error instanceof WebSearchError) throw error
      if (abortSignal.aborted) throw new WebSearchError('网页搜索已取消')
      if (timeoutSignal.aborted) throw new WebSearchError('Perplexity 网页搜索请求超时')
      throw new WebSearchError('无法连接 Perplexity 网页搜索服务')
    }
  }
}

function perplexityRequestBody(request: WebSearchRequest): Record<string, unknown> {
  return {
    query: request.queries.length === 1 ? request.queries[0] : request.queries,
    max_results: request.maxResults,
    search_context_size: 'low',
    ...(request.recency ? { search_recency_filter: request.recency } : {}),
    ...(request.domains?.length ? { search_domain_filter: request.domains } : {}),
  }
}

function statusError(status: number): WebSearchError {
  if (status === 401 || status === 403) {
    return new WebSearchError('Perplexity Search API key 无效或没有搜索权限')
  }
  if (status === 402) return new WebSearchError('Perplexity Search API 账户余额不足')
  if (status === 429) return new WebSearchError('Perplexity 搜索请求过于频繁或额度已用尽')
  if (status === 400 || status === 422) {
    return new WebSearchError('Perplexity 拒绝了当前搜索请求')
  }
  if (status >= 500) return new WebSearchError('Perplexity 网页搜索服务暂时不可用')
  return new WebSearchError(`Perplexity 网页搜索失败（HTTP ${status}）`)
}

function parseSearchResponse(value: unknown, maxResults: number): WebSearchResponse {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new WebSearchError('Perplexity 搜索响应格式不受支持')
  }
  const candidateResults = normalizeResultList(value.results).slice(0, maxResults)
  const results = candidateResults.flatMap((item) => {
    const result = parseResult(item)
    return result ? [result] : []
  })
  if (candidateResults.length > 0 && results.length === 0) {
    throw new WebSearchError('Perplexity 搜索结果格式不受支持')
  }
  return { results }
}

function normalizeResultList(value: unknown[]): unknown[] {
  if (value.every((item) => Array.isArray(item))) return value.flat()
  if (value.some((item) => Array.isArray(item))) {
    throw new WebSearchError('Perplexity 搜索响应格式不受支持')
  }
  return value
}

function parseResult(value: unknown): WebSearchResult | null {
  if (
    !isRecord(value)
    || typeof value.title !== 'string'
    || typeof value.url !== 'string'
    || typeof value.snippet !== 'string'
  ) return null
  return {
    title: value.title,
    url: value.url,
    snippet: value.snippet,
    ...(typeof value.date === 'string' ? { publishedDate: value.date } : {}),
    ...(typeof value.last_updated === 'string' ? { lastUpdated: value.last_updated } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
