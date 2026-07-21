import { randomUUID } from 'node:crypto'
import { WebPageError } from '@whycode/core'
import {
  runUtilityProcessJob,
  UtilityProcessJobError,
} from '../utility-process-job.ts'
import type { ExtractedWebPage } from './content.ts'
import type { WebTextDocument } from './network.ts'
import {
  isWebPageWorkerResponse,
  type WebPageWorkerRequest,
} from './protocol.ts'

const HTML_EXTRACTION_TIMEOUT_MS = 20_000

export async function extractWebTextDocument(
  document: WebTextDocument,
  abortSignal: AbortSignal,
): Promise<ExtractedWebPage> {
  const request: WebPageWorkerRequest = { id: randomUUID(), document }
  try {
    const response = await runUtilityProcessJob({
      workerName: 'web-page-worker.js',
      serviceName: 'WhyCode Web Page Extractor',
      request,
      abortSignal,
      timeoutMs: HTML_EXTRACTION_TIMEOUT_MS,
      maxOldSpaceSizeMb: 256,
    })
    if (!isWebPageWorkerResponse(response, request)) {
      throw new WebPageError('网页正文提取子进程返回了无效响应')
    }
    if (!response.ok) throw new WebPageError(response.error)
    return response.result
  } catch (error) {
    if (error instanceof WebPageError) throw error
    if (!(error instanceof UtilityProcessJobError)) {
      throw new WebPageError('网页正文提取失败')
    }
    if (error.failure === 'aborted') throw new WebPageError('网页读取已取消')
    if (error.failure === 'timeout') throw new WebPageError('网页正文提取超时')
    throw new WebPageError('网页正文提取服务不可用')
  }
}
