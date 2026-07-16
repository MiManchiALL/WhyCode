import type { PdfProcessingErrorCode } from '@whycode/core/pdf'
import type { PdfWorkerRequest, PdfWorkerResponse } from './protocol.ts'

const parentPort = process.parentPort
if (!parentPort) throw new Error('PDF utility process 缺少 parentPort')

// PDF.js 会把 Electron utility 误判为浏览器环境；专用进程只加载 PDF 引擎，
// 在加载前切换到其已支持的 Electron Main/Node 分支，避免字体渲染静默退化。
if (process.type === 'utility') Object.defineProperty(process, 'type', { value: 'browser' })

const canvas = await import('@napi-rs/canvas')
Object.assign(globalThis, {
  DOMMatrix: canvas.DOMMatrix,
  ImageData: canvas.ImageData,
  Path2D: canvas.Path2D,
})

parentPort.once('message', async (event) => {
  const request = event.data as PdfWorkerRequest
  let response: PdfWorkerResponse
  try {
    const { executePdfWorkerRequest } = await import('./engine.ts')
    response = { id: request.id, ok: true, result: await executePdfWorkerRequest(request) }
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: serializeError(error),
    }
  }
  parentPort.postMessage(response)
  setTimeout(() => process.exit(response.ok ? 0 : 1), 0)
})

function serializeError(error: unknown): { code: PdfProcessingErrorCode; message: string } {
  if (isPdfError(error)) return { code: error.code, message: error.message }
  return {
    code: 'unknown',
    message: error instanceof Error ? error.message : String(error),
  }
}

function isPdfError(error: unknown): error is Error & { code: PdfProcessingErrorCode } {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
}
