import type {
  PdfDocumentInfo,
  PdfPageReadOptions,
  PdfPageReadResult,
  PdfProcessingErrorCode,
} from '@whycode/core/pdf'

export type PdfWorkerRequest =
  | { id: string; operation: 'inspect'; path: string }
  | { id: string; operation: 'read-pages'; path: string; options: PdfPageReadOptions }

export type PdfWorkerResult = PdfDocumentInfo | PdfPageReadResult

export type PdfWorkerResponse =
  | { id: string; ok: true; result: PdfWorkerResult }
  | {
      id: string
      ok: false
      error: { code: PdfProcessingErrorCode; message: string }
    }
