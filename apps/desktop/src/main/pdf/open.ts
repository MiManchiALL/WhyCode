import { pdfAttachmentPath, type PdfAttachment } from '@whycode/core'

interface PdfOpenJournal {
  attachmentDirectory: string
  initialPdfAttachments: readonly PdfAttachment[]
}

export async function openPdfAttachment(
  journal: PdfOpenJournal | null,
  attachmentId: unknown,
  openPath: (path: string) => Promise<string>,
): Promise<{ ok: boolean; error?: string }> {
  const attachment = typeof attachmentId === 'string'
    ? journal?.initialPdfAttachments.find((item) => item.id === attachmentId)
    : undefined
  if (!journal || !attachment) return { ok: false, error: 'PDF 附件不存在或不属于当前会话' }
  const error = await openPath(pdfAttachmentPath(
    journal.attachmentDirectory,
    attachment.storageName,
  ))
  return error ? { ok: false, error } : { ok: true }
}
