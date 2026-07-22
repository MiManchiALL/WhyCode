import {
  WebSearchError,
  type WebSearchHandler,
  type WebSearchRecency,
  type WebSearchRequest,
  type WebSearchResponse,
  type WebSearchResult,
} from '@whycode/core'
import {
  postSearchJson,
  SEARCH_MAX_RESPONSE_BYTES,
  SEARCH_REQUEST_TIMEOUT_MS,
} from './http.ts'

const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search'

export interface TavilySearchOptions {
  getApiKey: () => string | undefined
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>
  timeoutMs?: number
}

export function createTavilySearchHandler(options: TavilySearchOptions): WebSearchHandler {
  return async (request, abortSignal) => {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? SEARCH_REQUEST_TIMEOUT_MS)
    const batchController = new AbortController()
    const signal = AbortSignal.any([abortSignal, timeoutSignal, batchController.signal])
    try {
      const apiKey = options.getApiKey()?.trim()
      if (!apiKey) {
        throw new WebSearchError(
          '尚未配置 Tavily Search API key，请在“⚙ 连接 → 网页搜索”中配置',
        )
      }
      const maxResponseBytes = Math.floor(
        SEARCH_MAX_RESPONSE_BYTES / request.queries.length,
      )
      const responses = await Promise.all(request.queries.map((query) => postSearchJson({
        endpoint: TAVILY_SEARCH_ENDPOINT,
        apiKey,
        body: tavilyRequestBody(request, query),
        serviceName: 'Tavily 搜索',
        signal,
        statusError,
        maxResponseBytes,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      })))
      return {
        results: responses.flatMap((response) => (
          parseSearchResponse(response, request.maxResults).results
        )),
      }
    } catch (error) {
      batchController.abort()
      if (error instanceof WebSearchError) throw error
      if (abortSignal.aborted) throw new WebSearchError('网页搜索已取消')
      if (timeoutSignal.aborted) throw new WebSearchError('Tavily 网页搜索请求超时')
      throw new WebSearchError('无法连接 Tavily 网页搜索服务')
    }
  }
}

function tavilyRequestBody(
  request: WebSearchRequest,
  query: string,
): Record<string, unknown> {
  return {
    query,
    max_results: request.maxResults,
    search_depth: 'basic',
    topic: 'general',
    include_answer: false,
    include_raw_content: false,
    include_images: false,
    auto_parameters: false,
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

function parseSearchResponse(value: unknown, maxResults: number): WebSearchResponse {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new WebSearchError('Tavily 搜索响应格式不受支持')
  }
  const candidates = value.results.slice(0, maxResults)
  const results = candidates.flatMap((item) => {
    const result = parseResult(item)
    return result ? [result] : []
  })
  if (candidates.length > 0 && results.length === 0) {
    throw new WebSearchError('Tavily 搜索结果格式不受支持')
  }
  return { results }
}

function parseResult(value: unknown): WebSearchResult | null {
  if (
    !isRecord(value)
    || typeof value.title !== 'string'
    || typeof value.url !== 'string'
    || typeof value.content !== 'string'
  ) return null
  return {
    title: value.title,
    url: value.url,
    snippet: value.content,
    ...(typeof value.published_date === 'string'
      ? { publishedDate: value.published_date }
      : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
