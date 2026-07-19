import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  PDF_ATTACHMENT_MAX_PAGES,
  PDF_ATTACHMENT_MAX_SOURCE_BYTES,
  PDF_TEXT_MAX_CHARS,
  PdfProcessingError,
  type PdfDocumentInfo,
  type PdfPageReadOptions,
  type PdfPageReadResult,
  type PdfProcessingErrorCode,
  type PdfProcessor,
} from '@whycode/core'
import {
  runUtilityProcessJob,
  UtilityProcessJobError,
} from '../utility-process-job.ts'
import {
  PDF_WEB_DOCUMENT_MAX_TEXT_CHARS,
  type PdfWebDocumentResult,
  type PdfWorkerRequest,
  type PdfWorkerResponse,
  type PdfWorkerResult,
} from './protocol.ts'

const PDF_INSPECT_TIMEOUT_MS = 30_000
const PDF_READ_TIMEOUT_MS = 30_000
const PDF_WEB_READ_TIMEOUT_MS = 60_000
/** 对齐 Claude Code 的 pdftoppm 分页提取超时。 */
const PDF_RENDER_TIMEOUT_MS = 120_000
const PDF_RENDER_MAX_DIMENSION_WITH_ROUNDING = 2_049
const PDF_RENDER_MAX_PIXELS = 20_000_000

export class ElectronPdfProcessor implements PdfProcessor {
  async inspect(path: string, abortSignal: AbortSignal): Promise<PdfDocumentInfo> {
    const result = await runPdfJob(
      { id: randomUUID(), operation: 'inspect', path },
      abortSignal,
      PDF_INSPECT_TIMEOUT_MS,
    )
    return result as PdfDocumentInfo
  }

  async readPages(
    path: string,
    options: PdfPageReadOptions,
    abortSignal: AbortSignal,
  ): Promise<PdfPageReadResult> {
    const result = await runPdfJob(
      { id: randomUUID(), operation: 'read-pages', path, options },
      abortSignal,
      options.mode === 'visual' ? PDF_RENDER_TIMEOUT_MS : PDF_READ_TIMEOUT_MS,
    )
    return result as PdfPageReadResult
  }

  async readWebDocument(
    path: string,
    abortSignal: AbortSignal,
  ): Promise<PdfWebDocumentResult> {
    const result = await runPdfJob(
      { id: randomUUID(), operation: 'read-web-document', path },
      abortSignal,
      PDF_WEB_READ_TIMEOUT_MS,
    )
    return result as PdfWebDocumentResult
  }
}

async function runPdfJob(
  request: PdfWorkerRequest,
  abortSignal: AbortSignal,
  timeoutMs: number,
): Promise<PdfWorkerResult> {
  try {
    const response = await runUtilityProcessJob({
      workerName: 'pdf-worker.js',
      serviceName: 'WhyCode PDF Processor',
      request,
      abortSignal,
      timeoutMs,
      maxOldSpaceSizeMb: 384,
    })
    if (!isWorkerResponse(response, request)) {
      throw new PdfProcessingError('unknown', 'PDF 子进程返回了无效响应')
    }
    if (response.ok) return response.result
    throw new PdfProcessingError(response.error.code, response.error.message)
  } catch (error) {
    if (error instanceof PdfProcessingError) throw error
    if (!(error instanceof UtilityProcessJobError)) {
      throw new PdfProcessingError('unknown', 'PDF 子进程处理失败', { cause: error })
    }
    if (error.failure === 'aborted') throw abortedError()
    if (error.failure === 'timeout') {
      throw new PdfProcessingError('timeout', 'PDF 处理超时，请缩小页数后重试')
    }
    if (error.failure === 'unavailable') {
      throw new PdfProcessingError('unavailable', 'PDF 子进程启动失败', { cause: error })
    }
    throw new PdfProcessingError('unknown', error.message, { cause: error })
  }
}

function isWorkerResponse(value: unknown, request: PdfWorkerRequest): value is PdfWorkerResponse {
  if (typeof value !== 'object' || value === null) return false
  if (!('id' in value) || value.id !== request.id || !('ok' in value)) return false
  if (value.ok === true) {
    return 'result' in value && isWorkerResult(value.result, request)
  }
  return value.ok === false && 'error' in value && isWorkerError(value.error)
}

function isWorkerResult(
  value: unknown,
  request: PdfWorkerRequest,
): value is PdfWorkerResult {
  if (
    !isRecord(value)
    || !isPositiveInteger(value.pageCount)
    || value.pageCount > PDF_ATTACHMENT_MAX_PAGES
  ) return false
  if (request.operation === 'inspect') {
    return isPositiveInteger(value.byteLength)
      && value.byteLength <= PDF_ATTACHMENT_MAX_SOURCE_BYTES
  }
  if (request.operation === 'read-web-document') {
    if (
      value.mode !== 'web-text'
      || !Array.isArray(value.pages)
      || typeof value.sourceTruncated !== 'boolean'
      || value.pages.length < 1
      || value.pages.length > value.pageCount
    ) return false
    let textChars = 0
    for (const [index, page] of value.pages.entries()) {
      if (
        !isRecord(page)
        || page.pageNumber !== index + 1
        || typeof page.text !== 'string'
      ) return false
      textChars += page.text.length
      if (textChars > PDF_WEB_DOCUMENT_MAX_TEXT_CHARS) return false
    }
    return value.pages.length === value.pageCount || value.sourceTruncated
  }
  const expectedCount = Math.min(
    request.options.pageCount,
    value.pageCount - request.options.startPage + 1,
  )
  if (expectedCount < 1 || value.mode !== request.options.mode) return false
  if (request.options.mode === 'text') {
    if (!Array.isArray(value.pages) || 'renderedPages' in value) return false
    return value.pages.length === expectedCount && value.pages.every((page, index) =>
      isRecord(page)
      && page.pageNumber === request.options.startPage + index
      && typeof page.text === 'string'
      && page.text.length <= PDF_TEXT_MAX_CHARS)
  }
  if (
    !Array.isArray(value.renderedPages)
    || 'pages' in value
    || value.renderedPages.length !== expectedCount
  ) return false
  const outputDirectory = request.options.outputDirectory

  return value.renderedPages.every((page, index) => {
    if (
      !isRecord(page)
      || page.pageNumber !== request.options.startPage + index
      || typeof page.path !== 'string'
      || !isPositiveInteger(page.width)
      || !isPositiveInteger(page.height)
      || Math.max(page.width, page.height) > PDF_RENDER_MAX_DIMENSION_WITH_ROUNDING
      || page.width * page.height > PDF_RENDER_MAX_PIXELS
    ) return false
    const expectedPath = join(
      resolve(outputDirectory),
      `page-${String(page.pageNumber).padStart(4, '0')}.jpg`,
    )
    return normalizePath(page.path) === normalizePath(expectedPath)
  })
}

function isWorkerError(value: unknown): value is { code: PdfProcessingErrorCode; message: string } {
  return isRecord(value)
    && 'code' in value
    && isPdfErrorCode(value.code)
    && 'message' in value
    && typeof value.message === 'string'
}

const PDF_ERROR_CODES: ReadonlySet<string> = new Set([
  'aborted', 'corrupted', 'empty', 'invalid-page-range', 'password-protected',
  'timeout', 'too-large', 'too-many-pages', 'unavailable', 'unknown',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isPdfErrorCode(value: unknown): value is PdfProcessingErrorCode {
  return typeof value === 'string' && PDF_ERROR_CODES.has(value)
}

function normalizePath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function abortedError(): PdfProcessingError {
  return new PdfProcessingError('aborted', 'PDF 处理已取消')
}
