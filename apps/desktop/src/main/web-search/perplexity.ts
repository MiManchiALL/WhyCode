import {
  WebSearchError,
  type WebSearchHandler,
  type WebSearchRequest,
  type WebSearchResponse,
  type WebSearchResult,
} from '@whycode/core'

const PERPLEXITY_SEARCH_ENDPOINT = 'https://api.perplexity.ai/search'
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 2_000_000

export interface PerplexitySearchOptions {
  getApiKey: () => string | undefined
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>
  timeoutMs?: number
}

export function createPerplexitySearchHandler(
  options: PerplexitySearchOptions,
): WebSearchHandler {
  return async (request, abortSignal) => {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const signal = AbortSignal.any([abortSignal, timeoutSignal])
    try {
      const apiKey = options.getApiKey()?.trim()
      if (!apiKey) {
        throw new WebSearchError(
          '尚未配置 Perplexity Search API key，请在“⚙ 连接 → 网页搜索”中配置',
        )
      }
      const response = await (options.fetchImpl ?? fetch)(PERPLEXITY_SEARCH_ENDPOINT, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(perplexityRequestBody(request)),
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        throw statusError(response.status)
      }
      return parseSearchResponse(await readBoundedResponse(response), request.maxResults)
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
    query: request.query,
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

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new WebSearchError('Perplexity 搜索响应超过安全大小限制')
  }
  if (!response.body) throw new WebSearchError('Perplexity 搜索返回了空响应')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new WebSearchError('Perplexity 搜索响应超过安全大小限制')
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function parseSearchResponse(body: string, maxResults: number): WebSearchResponse {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new WebSearchError('Perplexity 搜索返回了无效 JSON')
  }
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new WebSearchError('Perplexity 搜索响应格式不受支持')
  }
  const candidateResults = value.results.slice(0, maxResults)
  const results = candidateResults.flatMap((item) => {
    const result = parseResult(item)
    return result ? [result] : []
  })
  if (candidateResults.length > 0 && results.length === 0) {
    throw new WebSearchError('Perplexity 搜索结果格式不受支持')
  }
  return { results }
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
