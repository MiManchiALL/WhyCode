import { z } from 'zod'

/** 单条消息最多携带的图片数；与桌面选择器和持久化 schema 共用。 */
export const IMAGE_ATTACHMENT_MAX_COUNT = 4
/** 会话允许保存的原图上限；模型请求使用更小的衍生图边界。 */
export const IMAGE_ATTACHMENT_MAX_SOURCE_BYTES = 20_000_000
/** 避免 Base64 膨胀后把单张模型输入推到常见 5 MB 上限之外。 */
export const IMAGE_MODEL_MAX_BYTES = 3_750_000
/** 原图解码安全边界，用于拒绝像素炸弹。 */
export const IMAGE_ATTACHMENT_MAX_DIMENSION = 8_192
export const IMAGE_ATTACHMENT_MAX_PIXELS = 20_000_000
/** 当前已验通视觉 Provider 共用的请求级最长边。 */
export const IMAGE_MODEL_MAX_DIMENSION = 2_048

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
