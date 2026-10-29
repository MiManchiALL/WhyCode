import { z } from 'zod'
import {
  WebSearchError,
  type WebSearchHandler,
  type WebSearchRequest,
} from '@whycode/core'
import { requestDeepSeekWeb, type DeepSeekWebOptions } from '../deepseek-web.ts'
import { WEB_API_MAX_RESPONSE_BYTES } from '../web-http.ts'

const searchResponse = z.object({
  results: z.array(z.object({
    title: z.string(),
    url: z.string(),
    snippet: z.string(),
    summary: z.string(),
    date: z.string().nullable(),
  })).max(50),
})

export function createDeepSeekSearchHandler(options: DeepSeekWebOptions): WebSearchHandler {
  return async (request, abortSignal) => {
    // DeepSeek 一次只接受一个 query；共享调用的总响应预算，保留部分成功。
    const maxBytes = Math.floor(WEB_API_MAX_RESPONSE_BYTES / request.queries.length)
    const now = Date.now()
    const outcomes = await Promise.allSettled(request.queries.map(async (query) => {
      const payload = await requestDeepSeekWeb(options, 'search', {
        query: filteredQuery(query, request, now),
        count: request.maxResults,
        need_content: false,
      }, abortSignal, WebSearchError, maxBytes)
      const parsed = searchResponse.safeParse(payload)
      if (!parsed.success) throw new WebSearchError('DeepSeek 搜索响应格式不受支持')
      return parsed.data.results.slice(0, request.maxResults).map((item) => ({
        title: item.title || item.url,
        url: item.url,
        snippet: item.summary.trim() || item.snippet,
        ...(item.date ? { publishedDate: item.date } : {}),
      }))
    }))
    if (abortSignal.aborted) throw new WebSearchError('网页搜索已取消')
    const results = outcomes.flatMap((outcome) => outcome.status === 'fulfilled' ? outcome.value : [])
    const failures = outcomes.flatMap((outcome, index) => outcome.status === 'rejected' ? [{
      query: request.queries[index]!,
      message: outcome.reason instanceof WebSearchError
        ? outcome.reason.message : 'DeepSeek 网页搜索失败',
    }] : [])
    if (failures.length === outcomes.length) throw new WebSearchError(failures[0]!.message)
    return { results, ...(failures.length ? { failures } : {}) }
  }
}

function filteredQuery(query: string, request: WebSearchRequest, now: number): string {
  const parts = [query]
  if (request.domains?.length) {
    parts.push(request.domains.map((domain) => `site:${domain}`).join(' OR '))
  }
  if (request.recency === 'hour') {
    throw new WebSearchError('DeepSeek 仅支持按日期筛选；请将 recency 改为 day 或省略，并核对来源的发布时间')
  }
  if (request.recency) {
    const days = { day: 1, week: 7, month: 30, year: 365 }[request.recency]
    const date = new Date(now - days * 86_400_000).toISOString().slice(0, 10)
    parts.push(`after:${date}`)
  }
  const filtered = parts.join(' ')
  if (Array.from(filtered).length > 128) {
    throw new WebSearchError('DeepSeek 查询（含域名、日期筛选）最多 128 个 Unicode 字符；请缩短搜索词或减少 domains 后重试')
  }
  return filtered
}
