import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PdfProcessingError, WebPageError } from '@whycode/core'
import { ElectronPdfProcessor } from '../pdf/processor.ts'
import {
  runUtilityProcessJob,
  UtilityProcessJobError,
} from '../utility-process-job.ts'
import { createExtractedWebPage, type ExtractedWebPage } from './content.ts'
import type { WebDocument, WebPdfDocument, WebTextDocument } from './network.ts'
import {
  isWebPageWorkerResponse,
  type WebPageWorkerRequest,
} from './protocol.ts'

const HTML_EXTRACTION_TIMEOUT_MS = 20_000

export class ElectronWebPageProcessor {
  constructor(private readonly pdfProcessor: ElectronPdfProcessor) {}

  async extract(
    document: WebDocument,
    abortSignal: AbortSignal,
  ): Promise<ExtractedWebPage> {
    return document.kind === 'pdf'
      ? this.extractPdf(document, abortSignal)
      : extractTextDocument(document, abortSignal)
  }

  private async extractPdf(
    document: WebPdfDocument,
    abortSignal: AbortSignal,
  ): Promise<ExtractedWebPage> {
    if (abortSignal.aborted) throw new WebPageError('网页读取已取消')
    let directory: string | null = null
    try {
      directory = await mkdtemp(join(tmpdir(), 'whycode-web-pdf-'))
      const path = join(directory, 'document.pdf')
      await writeFile(path, document.bytes, { flag: 'wx', mode: 0o600 })
      const result = await this.pdfProcessor.readWebDocument(path, abortSignal)
      const markdown = result.pages.map((page) => [
        `## PDF 第 ${page.pageNumber} 页`,
        '',
        page.text || '（此页未提取到文本）',
      ].join('\n')).join('\n\n')
      return createExtractedWebPage(document, markdown, {
        sourceTruncated: result.sourceTruncated,
      })
    } catch (error) {
      if (error instanceof WebPageError) throw error
      if (error instanceof PdfProcessingError) throw pdfWebPageError(error)
      throw new WebPageError('远程 PDF 处理失败')
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
    }
  }
}

async function extractTextDocument(
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

function pdfWebPageError(error: PdfProcessingError): WebPageError {
  if (error.code === 'aborted') return new WebPageError('网页读取已取消')
  if (error.code === 'timeout') return new WebPageError('远程 PDF 解析超时')
  if (error.code === 'password-protected') return new WebPageError('远程 PDF 已加密，无法读取')
  if (error.code === 'too-large') return new WebPageError('远程 PDF 超过 50 MB 安全上限')
  if (error.code === 'too-many-pages') return new WebPageError('远程 PDF 超过 1000 页安全上限')
  if (error.code === 'empty' || error.code === 'corrupted') {
    return new WebPageError('远程 PDF 已损坏或格式无效')
  }
  return new WebPageError('远程 PDF 处理失败')
}
