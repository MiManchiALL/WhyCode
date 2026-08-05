import { z } from 'zod'
import {
  IMAGE_ATTACHMENT_MAX_DIMENSION,
  IMAGE_ATTACHMENT_MAX_PIXELS,
  IMAGE_ATTACHMENT_MAX_SOURCE_BYTES,
  TOOL_IMAGE_ATTACHMENT_MAX_COUNT,
  USER_IMAGE_ATTACHMENT_MAX_COUNT,
} from './limits.ts'
export {
  IMAGE_ATTACHMENT_MAX_DIMENSION,
  IMAGE_ATTACHMENT_MAX_PIXELS,
  IMAGE_ATTACHMENT_MAX_SOURCE_BYTES,
  IMAGE_MODEL_MAX_BYTES,
  IMAGE_MODEL_MAX_DIMENSION,
  TOOL_IMAGE_ATTACHMENT_MAX_COUNT,
  USER_IMAGE_ATTACHMENT_MAX_COUNT,
} from './limits.ts'

/** 宿主交付的有序图片来源；inline Base64 只允许在落盘边界短暂存在。 */
export type ImageAttachmentInput =
  | { kind: 'path'; path: string }
  | { kind: 'inline'; name: string; base64: string }

/** Renderer 重新提交中断后恢复的会话图片时只回传不透明 ID，Main 再按事实源解析。 */
export type ImageMessageAttachmentInput =
  | ImageAttachmentInput
  | { kind: 'stored'; attachmentId: string }

export const imageMediaTypeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/webp',
])

export const imageAttachmentStorageNameSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|webp)$/i)

export const imageAttachmentSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('pdf-page'),
    pdfAttachmentId: z.string().uuid(),
    pdfSha256: z.string().regex(/^[0-9a-f]{64}$/),
    pageNumber: z.number().int().positive(),
  }),
])

export const imageAttachmentSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  name: z.string().min(1).max(255),
  storageName: imageAttachmentStorageNameSchema,
  mediaType: imageMediaTypeSchema,
  /** 新附件必写；optional 仅用于读取图片第二阶段验收期间已产生的旧 v4 会话。 */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  byteLength: z.number().int().positive().max(IMAGE_ATTACHMENT_MAX_SOURCE_BYTES),
  width: z.number().int().positive().max(IMAGE_ATTACHMENT_MAX_DIMENSION),
  height: z.number().int().positive().max(IMAGE_ATTACHMENT_MAX_DIMENSION),
  /** 可重现衍生图的稳定来源；用于复用同一 PDF 页面而不是重复落盘。 */
  source: imageAttachmentSourceSchema.optional(),
}).superRefine((attachment, ctx) => {
  if (!attachment.storageName.toLowerCase().startsWith(`${attachment.id.toLowerCase()}.`)) {
    ctx.addIssue({ code: 'custom', path: ['storageName'], message: '存储名必须匹配附件 ID' })
  }
  if (attachment.width * attachment.height > IMAGE_ATTACHMENT_MAX_PIXELS) {
    ctx.addIssue({ code: 'custom', path: ['width'], message: '图片总像素超过上限' })
  }
})

export function createImageAttachmentsSchema(maxCount: number) {
  if (!Number.isSafeInteger(maxCount) || maxCount < 1) {
    throw new Error('图片附件数量上限必须是正整数')
  }
  return z
    .array(imageAttachmentSchema)
    .max(maxCount)
    .superRefine((attachments, ctx) => {
      const seen = new Set<string>()
      attachments.forEach((attachment, index) => {
        if (seen.has(attachment.id)) {
          ctx.addIssue({ code: 'custom', path: [index, 'id'], message: '图片附件不能重复' })
        }
        seen.add(attachment.id)
      })
    })
}

export const userImageAttachmentsSchema = createImageAttachmentsSchema(
  USER_IMAGE_ATTACHMENT_MAX_COUNT,
)
export const toolImageAttachmentsSchema = createImageAttachmentsSchema(
  TOOL_IMAGE_ATTACHMENT_MAX_COUNT,
)

export type ImageMediaType = z.infer<typeof imageMediaTypeSchema>
export type ImageAttachmentSource = z.infer<typeof imageAttachmentSourceSchema>

export const imageDetailSchema = z.enum(['high', 'original'])
export type ImageDetail = z.infer<typeof imageDetailSchema>

export const imageRegionSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive().max(100_000),
  height: z.number().int().positive().max(100_000),
})
export type ImageRegion = z.infer<typeof imageRegionSchema>

export const imageTransformSchema = z.object({
  detail: imageDetailSchema.default('high'),
  region: imageRegionSchema.optional(),
})
export type ImageTransform = z.infer<typeof imageTransformSchema>
export type ImageAttachment = z.infer<typeof imageAttachmentSchema>
