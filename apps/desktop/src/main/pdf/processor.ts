import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { utilityProcess } from 'electron'
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
import type { PdfWorkerRequest, PdfWorkerResponse, PdfWorkerResult } from './protocol.ts'

const PDF_INSPECT_TIMEOUT_MS = 30_000
const PDF_READ_TIMEOUT_MS = 30_000
const PDF_RENDER_TIMEOUT_MS = 60_000
const STDERR_MAX_CHARS = 8_000
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
      options.render ? PDF_RENDER_TIMEOUT_MS : PDF_READ_TIMEOUT_MS,
    )
    return result as PdfPageReadResult
  }
}

async function runPdfJob(
  request: PdfWorkerRequest,
  abortSignal: AbortSignal,
  timeoutMs: number,
): Promise<PdfWorkerResult> {
  if (abortSignal.aborted) throw abortedError()
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'pdf-worker.js')
  let child: ReturnType<typeof utilityProcess.fork>
  try {
    child = utilityProcess.fork(workerPath, [], {
      serviceName: 'WhyCode PDF Processor',
      stdio: 'pipe',
      execArgv: ['--max-old-space-size=384'],
    })
  } catch (error) {
    throw new PdfProcessingError('unavailable', 'PDF 子进程启动失败', { cause: error })
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let stderr = ''
    const finish = (error?: Error, value?: PdfWorkerResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      abortSignal.removeEventListener('abort', onAbort)
      child.kill()
      if (error) reject(error)
      else resolve(value!)
    }
    const onAbort = () => finish(abortedError())
    const timeout = setTimeout(
      () => finish(new PdfProcessingError('timeout', 'PDF 处理超时，请缩小页数后重试')),
      timeoutMs,
    )
    abortSignal.addEventListener('abort', onAbort, { once: true })
    child.stdout?.resume()
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-STDERR_MAX_CHARS)
    })
    child.once('spawn', () => child.postMessage(request))
    child.once('message', (response) => {
      if (!isWorkerResponse(response, request)) {
        finish(new PdfProcessingError('unknown', 'PDF 子进程返回了无效响应'))
        return
      }
      if (response.ok) finish(undefined, response.result)
      else finish(new PdfProcessingError(response.error.code, response.error.message))
    })
    child.once('error', () => {
      finish(new PdfProcessingError('unavailable', 'PDF 子进程启动失败'))
    })
    child.once('exit', (code) => {
      if (settled) return
      const suffix = stderr.trim() ? `：${stderr.trim()}` : ''
      finish(new PdfProcessingError('unknown', `PDF 子进程异常退出（${code}）${suffix}`))
    })
  })
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
  if (!Array.isArray(value.pages) || !Array.isArray(value.renderedPages)) return false

  const expectedCount = Math.min(
    request.options.pageCount,
    value.pageCount - request.options.startPage + 1,
  )
  if (expectedCount < 1 || value.pages.length !== expectedCount) return false
  const pagesValid = value.pages.every((page, index) =>
    isRecord(page)
    && page.pageNumber === request.options.startPage + index
    && typeof page.text === 'string'
    && page.text.length <= PDF_TEXT_MAX_CHARS)
  if (!pagesValid) return false
  if (!request.options.render) return value.renderedPages.length === 0
  if (
    !request.options.outputDirectory
    || value.renderedPages.length !== expectedCount
  ) return false

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
      resolve(request.options.outputDirectory!),
      `page-${String(page.pageNumber).padStart(4, '0')}.png`,
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
