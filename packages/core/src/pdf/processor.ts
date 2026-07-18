export interface PdfDocumentInfo {
  pageCount: number
  byteLength: number
}

export interface PdfPageText {
  pageNumber: number
  text: string
}

export interface PdfRenderedPage {
  pageNumber: number
  path: string
  width: number
  height: number
}

interface PdfPageReadOptionsBase {
  startPage: number
  pageCount: number
  /** 会话附件读取时绑定导入摘要；项目路径读取不提供。 */
  expectedSha256?: string
}

export type PdfPageReadOptions =
  | (PdfPageReadOptionsBase & { mode: 'text' })
  | (PdfPageReadOptionsBase & {
      mode: 'visual'
      /** 视觉模式只会在该私有目录写入页图。 */
      outputDirectory: string
    })

export type PdfPageReadResult =
  | { mode: 'text'; pageCount: number; pages: PdfPageText[] }
  | { mode: 'visual'; pageCount: number; renderedPages: PdfRenderedPage[] }

/** Core 只依赖此端口；Electron 用隔离 utility process 提供实现。 */
export interface PdfProcessor {
  inspect(path: string, abortSignal: AbortSignal): Promise<PdfDocumentInfo>
  readPages(
    path: string,
    options: PdfPageReadOptions,
    abortSignal: AbortSignal,
  ): Promise<PdfPageReadResult>
}

export type PdfProcessingErrorCode =
  | 'aborted'
  | 'corrupted'
  | 'empty'
  | 'invalid-page-range'
  | 'password-protected'
  | 'timeout'
  | 'too-large'
  | 'too-many-pages'
  | 'unavailable'
  | 'unknown'

export class PdfProcessingError extends Error {
  readonly code: PdfProcessingErrorCode

  constructor(code: PdfProcessingErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PdfProcessingError'
    this.code = code
  }
}
