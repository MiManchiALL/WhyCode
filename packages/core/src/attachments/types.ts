import { z } from 'zod'

/** 单条消息最多携带的图片数；与桌面选择器和持久化 schema 共用。 */
export const IMAGE_ATTACHMENT_MAX_COUNT = 4
/** 避免 Base64 膨胀后把单张图片请求推到常见 5 MB 上限之外。 */
export const IMAGE_ATTACHMENT_MAX_BYTES = 3_750_000
/** 不在 Core 引入图像处理依赖；用像素边界拒绝解压炸弹。 */
export const IMAGE_ATTACHMENT_MAX_DIMENSION = 8_192
export const IMAGE_ATTACHMENT_MAX_PIXELS = 20_000_000

export const imageMediaTypeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/webp',
])

export const imageAttachmentStorageNameSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|webp)$/i)

export const imageAttachmentSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  name: z.string().min(1).max(255),
  storageName: imageAttachmentStorageNameSchema,
  mediaType: imageMediaTypeSchema,
  byteLength: z.number().int().positive().max(IMAGE_ATTACHMENT_MAX_BYTES),
  width: z.number().int().positive().max(IMAGE_ATTACHMENT_MAX_DIMENSION),
  height: z.number().int().positive().max(IMAGE_ATTACHMENT_MAX_DIMENSION),
}).superRefine((attachment, ctx) => {
  if (!attachment.storageName.toLowerCase().startsWith(`${attachment.id.toLowerCase()}.`)) {
    ctx.addIssue({ code: 'custom', path: ['storageName'], message: '存储名必须匹配附件 ID' })
  }
  if (attachment.width * attachment.height > IMAGE_ATTACHMENT_MAX_PIXELS) {
    ctx.addIssue({ code: 'custom', path: ['width'], message: '图片总像素超过上限' })
  }
})

export const imageAttachmentsSchema = z
  .array(imageAttachmentSchema)
  .max(IMAGE_ATTACHMENT_MAX_COUNT)
  .superRefine((attachments, ctx) => {
    const seen = new Set<string>()
    attachments.forEach((attachment, index) => {
      if (seen.has(attachment.id)) {
        ctx.addIssue({ code: 'custom', path: [index, 'id'], message: '图片附件不能重复' })
      }
      seen.add(attachment.id)
    })
  })

export type ImageMediaType = z.infer<typeof imageMediaTypeSchema>
export type ImageAttachment = z.infer<typeof imageAttachmentSchema>
