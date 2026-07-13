import type { ModelMessage } from 'ai'
import { readStoredImage } from './storage.ts'
import {
  imageAttachmentSchema,
  imageAttachmentStorageNameSchema,
  type ImageAttachment,
} from './types.ts'

const ATTACHMENT_REF_PREFIX = 'whycode-attachment-ref:v1:'

export function createImageUserMessage(
  text: string,
  attachments: readonly ImageAttachment[],
): ModelMessage {
  return buildImageUserMessage(text, attachments.map((attachment) => ({
    attachment,
    data: attachmentReference(attachment.storageName),
  })))
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
        return { ...part, data: attachmentReference(part.filename) }
      }),
    }
  })
}

export async function hydrateImageMessages(
  messages: readonly ModelMessage[],
  attachmentDirectory: string,
  attachmentMetadata?: readonly ImageAttachment[],
): Promise<ModelMessage[]> {
  const metadataByStorageName = attachmentMetadata
    ? indexAttachmentMetadata(attachmentMetadata)
    : null
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
      const storageName = parseAttachmentReference(part.data)
      if (!storageName) {
        content.push(structuredClone(part))
        continue
      }
      if (part.filename !== storageName) throw new Error('图片附件引用与文件名不一致')
      const expected = metadataByStorageName?.get(storageName)
      if (metadataByStorageName && !expected) throw new Error('图片附件引用缺少权威元数据')
      const stored = await readStoredImage(attachmentDirectory, storageName)
      if (stored.mediaType !== part.mediaType) throw new Error('图片附件媒体类型不一致')
      if (expected && (
        stored.bytes.byteLength !== expected.byteLength
        || stored.width !== expected.width
        || stored.height !== expected.height
        || stored.mediaType !== expected.mediaType
      )) {
        throw new Error(`图片附件元数据与磁盘文件不一致：${storageName}`)
      }
      content.push({ ...part, data: stored.bytes.toString('base64') })
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
): Promise<ModelMessage[]> {
  if (supportsImageInput) {
    if (!hasStoredImageReferences(messages)) return [...messages]
    if (!attachmentDirectory) throw new Error('视觉模型请求缺少会话附件目录')
    return hydrateImageMessages(messages, attachmentDirectory, attachmentMetadata)
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
      && part.data.startsWith(ATTACHMENT_REF_PREFIX)))
}

function buildImageUserMessage(
  text: string,
  entries: readonly { attachment: ImageAttachment; data: string }[],
): ModelMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...entries.flatMap(({ attachment, data }, index) => [
        { type: 'text' as const, text: `[图片 ${index + 1}：${attachment.name}]` },
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

function attachmentReference(storageName: string): string {
  return `${ATTACHMENT_REF_PREFIX}${imageAttachmentStorageNameSchema.parse(storageName)}`
}

function parseAttachmentReference(value: string): string | null {
  if (!value.startsWith(ATTACHMENT_REF_PREFIX)) return null
  return imageAttachmentStorageNameSchema.parse(value.slice(ATTACHMENT_REF_PREFIX.length))
}
