import type {
  PdfDocumentInfo,
  PdfPageText,
  PdfPageReadOptions,
  PdfPageReadResult,
  PdfProcessingErrorCode,
} from '@whycode/core/pdf'
import { WEB_PAGE_MAX_CONTENT_CHARS } from '../web-page/content.ts'

export interface PdfWebDocumentResult {
  mode: 'web-text'
  pageCount: number
  pages: PdfPageText[]
  sourceTruncated: boolean
}

export type PdfWorkerRequest =
  | { id: string; operation: 'inspect'; path: string }
  | { id: string; operation: 'read-pages'; path: string; options: PdfPageReadOptions }
  | { id: string; operation: 'read-web-document'; path: string }

export type PdfWorkerResult = PdfDocumentInfo | PdfPageReadResult | PdfWebDocumentResult

export const PDF_WEB_DOCUMENT_MAX_TEXT_CHARS = WEB_PAGE_MAX_CONTENT_CHARS

export type PdfWorkerResponse =
  | { id: string; ok: true; result: PdfWorkerResult }
  | {
      id: string
      ok: false
      error: { code: PdfProcessingErrorCode; message: string }
    }
