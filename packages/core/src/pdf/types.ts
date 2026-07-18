import { z } from 'zod'
import {
  PDF_ATTACHMENT_MAX_COUNT,
  PDF_ATTACHMENT_MAX_PAGES,
  PDF_ATTACHMENT_MAX_SOURCE_BYTES,
  PDF_ATTACHMENT_MAX_TOTAL_BYTES,
} from './limits.ts'

export {
  PDF_ATTACHMENT_MAX_COUNT,
  PDF_ATTACHMENT_MAX_PAGES,
  PDF_ATTACHMENT_MAX_SOURCE_BYTES,
  PDF_ATTACHMENT_MAX_TOTAL_BYTES,
  PDF_INLINE_VISUAL_MAX_BYTES,
  PDF_INLINE_VISUAL_MAX_PAGES,
  PDF_TEXT_DEFAULT_PAGES,
  PDF_TEXT_MAX_CHARS,
  PDF_TEXT_MAX_PAGES,
  PDF_VISUAL_MAX_BYTES,
  PDF_VISUAL_MAX_PAGES,
} from './limits.ts'

/** PDF 不允许 inline Base64；无路径的大文件不能跨 JSON-safe IPC 传输。 */
export type PdfAttachmentInput = { kind: 'path'; path: string }

/** 恢复草稿只回传不透明 ID，由 Main 按会话事实源解析。 */
export type PdfMessageAttachmentInput =
  | PdfAttachmentInput
  | { kind: 'stored'; attachmentId: string }

export const pdfAttachmentStorageNameSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/i)

export const pdfAttachmentSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  name: z.string().min(1).max(255),
  storageName: pdfAttachmentStorageNameSchema,
  mediaType: z.literal('application/pdf'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteLength: z.number().int().positive().max(PDF_ATTACHMENT_MAX_SOURCE_BYTES),
  pageCount: z.number().int().positive().max(PDF_ATTACHMENT_MAX_PAGES),
}).superRefine((attachment, ctx) => {
  if (attachment.storageName.toLowerCase() !== `${attachment.id.toLowerCase()}.pdf`) {
    ctx.addIssue({ code: 'custom', path: ['storageName'], message: 'PDF 存储名必须匹配附件 ID' })
  }
})

export const pdfAttachmentsSchema = z
  .array(pdfAttachmentSchema)
  .max(PDF_ATTACHMENT_MAX_COUNT)
  .superRefine((attachments, ctx) => {
    const seen = new Set<string>()
    let totalBytes = 0
    attachments.forEach((attachment, index) => {
      if (seen.has(attachment.id)) {
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: 'PDF 附件不能重复' })
      }
      seen.add(attachment.id)
      totalBytes += attachment.byteLength
    })
    if (totalBytes > PDF_ATTACHMENT_MAX_TOTAL_BYTES) {
      ctx.addIssue({ code: 'custom', message: 'PDF 附件总大小超过单条消息上限' })
    }
  })

export type PdfAttachment = z.infer<typeof pdfAttachmentSchema>
