import type {
  PdfMessageAttachmentInput,
  QueuedUserMessage,
} from '@whycode/core'
import {
  PDF_ATTACHMENT_MAX_COUNT,
  PDF_ATTACHMENT_MAX_SOURCE_BYTES,
  PDF_ATTACHMENT_MAX_TOTAL_BYTES,
} from '@whycode/core/pdf-limits'

interface PdfDraftBase {
  id: string
  name: string
  byteLength: number
  pageCount?: number
}

export type PdfDraft =
  | (PdfDraftBase & { kind: 'path'; path: string })
  | (PdfDraftBase & { kind: 'stored'; attachmentId: string })

export const MAX_PDF_DRAFTS = PDF_ATTACHMENT_MAX_COUNT
export const MAX_PDF_DRAFT_BYTES = PDF_ATTACHMENT_MAX_SOURCE_BYTES
export const MAX_PDF_DRAFT_TOTAL_BYTES = PDF_ATTACHMENT_MAX_TOTAL_BYTES

export function preparePdfDrafts(
  drafts: readonly PdfDraft[],
): PdfMessageAttachmentInput[] {
  return drafts.map((draft) => draft.kind === 'path'
    ? { kind: 'path', path: draft.path }
    : { kind: 'stored', attachmentId: draft.attachmentId })
}

export function restoredPdfDrafts(messages: readonly QueuedUserMessage[]): PdfDraft[] {
  return messages.flatMap((message) => (message.pdfAttachments ?? []).map((attachment) => ({
    kind: 'stored' as const,
    id: attachment.id,
    name: attachment.name,
    byteLength: attachment.byteLength,
    pageCount: attachment.pageCount,
    attachmentId: attachment.id,
  })))
}
