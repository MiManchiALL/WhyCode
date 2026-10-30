import { z } from 'zod'
import { WebPageError } from '@whycode/core'
import type { WhycodeConfig } from '../config.ts'
import { requestDeepSeekWeb, type DeepSeekWebOptions } from '../deepseek-web.ts'
import { assertPublicWebTarget, parseWebPageUrl, type WebHostResolver } from './url-safety.ts'
import { WEB_DOCUMENT_MAX_BYTES, WEB_DOCUMENT_TIMEOUT_MS, type WebDocument } from './network.ts'

interface ConfiguredWebDocumentOptions {
  getConfig: () => WhycodeConfig | null
  fetchBuiltin: (url: string, signal: AbortSignal) => Promise<WebDocument>
  resolveHost: WebHostResolver
  fetchImpl?: DeepSeekWebOptions['fetchImpl']
  timeoutMs?: number
}

const pageResponse = z.object({ title: z.string(), content: z.string().trim().min(1) })

export function createConfiguredWebDocumentFetcher(options: ConfiguredWebDocumentOptions) {
  return async (url: string, abortSignal: AbortSignal): Promise<WebDocument> => {
    const config = options.getConfig()
    const target = parseWebPageUrl(url)
    // 已知 PDF 继续走原有附件导入；DeepSeek Fetch 只承诺 Markdown 正文。
    if ((config?.webFetch?.provider ?? 'builtin') === 'builtin'
      || target.pathname.toLowerCase().endsWith('.pdf')) {
      return options.fetchBuiltin(target.toString(), abortSignal)
    }
    const timeout = AbortSignal.timeout(options.timeoutMs ?? WEB_DOCUMENT_TIMEOUT_MS)
    const signal = AbortSignal.any([abortSignal, timeout])
    try {
      signal.throwIfAborted()
      await assertPublicWebTarget(target, options.resolveHost, signal)
      const payload = await requestDeepSeekWeb({
        getApiKey: () => config?.webSearch?.deepseek?.apiKey,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      }, 'fetch', { url: target.toString() }, signal, WebPageError, WEB_DOCUMENT_MAX_BYTES)
      const parsed = pageResponse.safeParse(payload)
      if (!parsed.success) throw new WebPageError('DeepSeek 抓取响应缺少有效标题或正文')
      return {
        kind: 'text',
        requestedUrl: target.toString(),
        // API 不报告跳转后的地址；引用保留原始请求 URL。
        finalUrl: target.toString(),
        contentType: 'text/markdown',
        title: parsed.data.title.replace(/\s+/gu, ' ').trim().slice(0, 500),
        text: parsed.data.content,
      }
    } catch (error) {
      if (abortSignal.aborted) throw new WebPageError('网页抓取已取消')
      if (timeout.aborted) throw new WebPageError('DeepSeek 网页抓取请求超时，请稍后重试')
      throw error
    }
  }
}
