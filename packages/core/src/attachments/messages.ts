import type { ModelMessage } from 'ai'
import { prepareImageAttachmentForModel } from './renditions.ts'
import {
  imageAttachmentSchema,
  imageAttachmentStorageNameSchema,
  type ImageAttachment,
  type ImageTransform,
} from './types.ts'

const ATTACHMENT_REF_V1_PREFIX = 'whycode-attachment-ref:v1:'
const ATTACHMENT_REF_V2_PREFIX = 'whycode-attachment-ref:v2:'
const DEFAULT_IMAGE_TRANSFORM: ImageTransform = { detail: 'high' }

export function createImageUserMessage(
  text: string,
  attachments: readonly ImageAttachment[],
): ModelMessage {
  return buildImageUserMessage(text, attachments.map((attachment) => ({
    attachment,
    data: attachmentReference(attachment.storageName),
  })), (attachment, index) => `[图片 ${index + 1}：${attachment.name}]`)
}

/** 图片工具的内部模型消息；不进入用户可见时间线。 */
export function createImageToolResultMessage(
  attachments: readonly ImageAttachment[],
  transform: ImageTransform = DEFAULT_IMAGE_TRANSFORM,
  sourceToolCallId?: string,
): ModelMessage {
  return buildImageUserMessage(
    [
      sourceToolCallId ? imageToolResultMarker(sourceToolCallId) : '',
      '以下图片由视觉工具读取或采集，仅作为刚才工具调用的视觉结果。',
    ].filter(Boolean).join('\n'),
    attachments.map((attachment) => ({
      attachment,
      data: attachmentReference(attachment.storageName, transform),
    })),
    (attachment, index) => `[视觉工具结果 ${index + 1}：${attachment.name}]`,
  )
}

/** 微清理用稳定关联；只解析应用生成且位于内部 user 消息开头的标记。 */
export function imageToolResultSourceId(message: ModelMessage): string | null {
  if (message.role !== 'user') return null
  const text = typeof message.content === 'string'
    ? message.content
    : message.content.find((part) => part.type === 'text')?.text
  if (!text) return null
  const match = /^<whycode-image-tool-result tool-call-id="([^"]+)"\s*\/>(?:\n|$)/.exec(text)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return null
  }
}

export function dehydrateImageMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== 'user' || typeof message.content === 'string') return structuredClone(message)
    return {
      ...message,
      content: message.content.map((part) => {
        if (
          part.type !== 'file'
          || !part.mediaType.startsWith('image/')
          || !part.filename
          || !imageAttachmentStorageNameSchema.safeParse(part.filename).success
        ) return structuredClone(part)
        const existing = typeof part.data === 'string'
          ? parseAttachmentReference(part.data)
          : null
        return {
          ...part,
          data: attachmentReference(
            part.filename,
            existing?.storageName === part.filename ? existing.transform : DEFAULT_IMAGE_TRANSFORM,
          ),
        }
      }),
    }
  })
}

export async function hydrateImageMessages(
  messages: readonly ModelMessage[],
  attachmentDirectory: string,
  attachmentMetadata?: readonly ImageAttachment[],
  abortSignal?: AbortSignal,
): Promise<ModelMessage[]> {
  const metadataByStorageName = indexAttachmentMetadata(attachmentMetadata ?? [])
  const hydrated: ModelMessage[] = []
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content === 'string') {
      hydrated.push(structuredClone(message))
      continue
    }
    const content: typeof message.content = []
    for (const part of message.content) {
      if (part.type !== 'file' || typeof part.data !== 'string') {
        content.push(structuredClone(part))
        continue
      }
      const reference = parseAttachmentReference(part.data)
      if (!reference) {
        content.push(structuredClone(part))
        continue
      }
      if (part.filename !== reference.storageName) throw new Error('图片附件引用与文件名不一致')
      const expected = metadataByStorageName.get(reference.storageName)
      if (!expected) throw new Error('图片附件引用缺少权威元数据')
      if (expected.mediaType !== part.mediaType) throw new Error('图片附件媒体类型不一致')
      const prepared = await prepareImageAttachmentForModel(
        attachmentDirectory,
        expected,
        abortSignal,
        reference.transform,
      )
      content.push({
        ...part,
        data: prepared.bytes.toString('base64'),
        mediaType: prepared.mediaType,
      })
    }
    hydrated.push({ ...message, content })
  }
  return hydrated
}

/** 请求副本适配：视觉模型临时水合，非视觉模型明确降级且不收到图片字节。 */
export async function messagesForModel(
  messages: readonly ModelMessage[],
  supportsImageInput: boolean,
  attachmentDirectory?: string,
  attachmentMetadata?: readonly ImageAttachment[],
  abortSignal?: AbortSignal,
): Promise<ModelMessage[]> {
  if (supportsImageInput) {
    if (!hasStoredImageReferences(messages)) return [...messages]
    if (!attachmentDirectory) throw new Error('视觉模型请求缺少会话附件目录')
    return hydrateImageMessages(
      messages,
      attachmentDirectory,
      attachmentMetadata,
      abortSignal,
    )
  }
  return messages.map((message) => {
    if (message.role !== 'user' || typeof message.content === 'string') return message
    let hiddenImages = 0
    const content = message.content.flatMap((part) => {
      if (
        part.type === 'image'
        || (part.type === 'file' && part.mediaType.startsWith('image/'))
      ) {
        hiddenImages++
        return []
      }
      return [part]
    })
    if (hiddenImages > 0) {
      content.push({
        type: 'text',
        text: `[本轮包含 ${hiddenImages} 张图片；当前模型不支持识图，图片内容不可见。]`,
      })
    }
    return { ...message, content }
  })
}

function indexAttachmentMetadata(
  attachments: readonly ImageAttachment[],
): Map<string, ImageAttachment> {
  const indexed = new Map<string, ImageAttachment>()
  for (const value of attachments) {
    const attachment = imageAttachmentSchema.parse(value)
    const previous = indexed.get(attachment.storageName)
    if (previous && JSON.stringify(previous) !== JSON.stringify(attachment)) {
      throw new Error(`同一图片附件存在冲突元数据：${attachment.storageName}`)
    }
    indexed.set(attachment.storageName, attachment)
  }
  return indexed
}

function hasStoredImageReferences(messages: readonly ModelMessage[]): boolean {
  return messages.some((message) =>
    message.role === 'user'
    && typeof message.content !== 'string'
    && message.content.some((part) =>
      part.type === 'file'
      && typeof part.data === 'string'
      && (
        part.data.startsWith(ATTACHMENT_REF_V1_PREFIX)
        || part.data.startsWith(ATTACHMENT_REF_V2_PREFIX)
      )))
}

function buildImageUserMessage(
  text: string,
  entries: readonly { attachment: ImageAttachment; data: string }[],
  label: (attachment: ImageAttachment, index: number) => string,
): ModelMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...entries.flatMap(({ attachment, data }, index) => [
        { type: 'text' as const, text: label(attachment, index) },
        {
          type: 'file' as const,
          data,
          filename: attachment.storageName,
          mediaType: attachment.mediaType,
        },
      ]),
    ],
  }
}

function attachmentReference(
  storageName: string,
  transform: ImageTransform = DEFAULT_IMAGE_TRANSFORM,
): string {
  const safeName = imageAttachmentStorageNameSchema.parse(storageName)
  if (transform.detail === 'high' && !transform.region) {
    return `${ATTACHMENT_REF_V1_PREFIX}${safeName}`
  }
  const region = transform.region
    ? `${transform.region.x},${transform.region.y},${transform.region.width},${transform.region.height}`
    : '-'
  return `${ATTACHMENT_REF_V2_PREFIX}${safeName}:${transform.detail}:${region}`
}

function imageToolResultMarker(toolCallId: string): string {
  return `<whycode-image-tool-result tool-call-id="${encodeURIComponent(toolCallId)}" />`
}

function parseAttachmentReference(
  value: string,
): { storageName: string; transform: ImageTransform } | null {
  if (value.startsWith(ATTACHMENT_REF_V1_PREFIX)) {
    return {
      storageName: imageAttachmentStorageNameSchema.parse(
        value.slice(ATTACHMENT_REF_V1_PREFIX.length),
      ),
      transform: DEFAULT_IMAGE_TRANSFORM,
    }
  }
  if (!value.startsWith(ATTACHMENT_REF_V2_PREFIX)) return null
  const [storageName, detail, regionValue, ...extra] = value
    .slice(ATTACHMENT_REF_V2_PREFIX.length)
    .split(':')
  if (!storageName || !detail || !regionValue || extra.length > 0) {
    throw new Error('图片附件变换引用无效')
  }
  const region = regionValue === '-'
    ? undefined
    : parseRegion(regionValue)
  return {
    storageName: imageAttachmentStorageNameSchema.parse(storageName),
    transform: {
      detail: detail === 'original' ? 'original' : detail === 'high' ? 'high' : invalidDetail(),
      ...(region ? { region } : {}),
    },
  }
}

function parseRegion(value: string): NonNullable<ImageTransform['region']> {
  const numbers = value.split(',').map(Number)
  if (
    numbers.length !== 4
    || numbers.some((number) => !Number.isSafeInteger(number))
  ) throw new Error('图片区域引用无效')
  const [x, y, width, height] = numbers as [number, number, number, number]
  if (x < 0 || y < 0 || width <= 0 || height <= 0) throw new Error('图片区域引用无效')
  return { x, y, width, height }
}

function invalidDetail(): never {
  throw new Error('图片细节级别引用无效')
}
