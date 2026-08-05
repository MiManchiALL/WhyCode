import type { ModelMessage, ToolResultPart } from 'ai'
import {
  dehydrateImageMessages,
  hasStoredImageReferences,
  hydrateImageMessages,
} from './message-storage.ts'
import {
  createImageAttachmentIdReference,
  createImageAttachmentReference,
  findImageAttachmentIdReferences,
  parseImageAttachmentReference,
} from './references.ts'
import type { ImageAttachment, ImageDeliveryMode } from './types.ts'

type ToolContentOutput = Extract<ToolResultPart['output'], { type: 'content' }>
type ToolContentPart = ToolContentOutput['value'][number]

export { dehydrateImageMessages, hydrateImageMessages }

export function createImageUserMessage(
  text: string,
  attachments: readonly ImageAttachment[],
  deliveryMode: ImageDeliveryMode = 'native',
): ModelMessage {
  return {
    role: 'user',
    content: [
      ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
      ...attachments.flatMap((attachment, index) => deliveryMode === 'native'
        ? [
            {
              type: 'text' as const,
              text: `[图片 ${index + 1}：${attachment.name}；附件 ID：${attachment.id}]`,
            },
            {
              type: 'file' as const,
              data: createImageAttachmentReference(attachment.storageName),
              filename: attachment.storageName,
              mediaType: attachment.mediaType,
            },
          ]
        : [{
            type: 'text' as const,
            text: `[图片 ${index + 1}：${attachment.name}；附件 ID：${attachment.id}；像素需调用 AnalyzeImage。]\n${createImageAttachmentIdReference(attachment.id)}`,
          }]),
    ],
  }
}

/** 请求副本适配：视觉模型临时水合，非视觉模型明确降级且不收到图片字节。 */
export async function messagesForModel(
  messages: readonly ModelMessage[],
  supportsImageInput: boolean,
  attachmentDirectory?: string,
  attachmentMetadata?: readonly ImageAttachment[],
  abortSignal?: AbortSignal,
  auxiliaryImageAnalysisAvailable = false,
): Promise<ModelMessage[]> {
  if (!supportsImageInput) {
    return messages.map((message) =>
      stripImagesForNonVisualModel(message, auxiliaryImageAnalysisAvailable))
  }
  if (!hasStoredImageReferences(messages)) return [...messages]
  if (!attachmentDirectory) throw new Error('视觉模型请求缺少会话附件目录')
  return hydrateImageMessages(
    messages,
    attachmentDirectory,
    attachmentMetadata,
    abortSignal,
  )
}

function stripImagesForNonVisualModel(
  message: ModelMessage,
  auxiliaryImageAnalysisAvailable: boolean,
): ModelMessage {
  if (message.role === 'user' && typeof message.content !== 'string') {
    let hiddenImages = 0
    const content = message.content.flatMap((part) => {
      if (part.type === 'image' || (part.type === 'file' && part.mediaType.startsWith('image/'))) {
        hiddenImages++
        return []
      }
      return [part]
    })
    if (hiddenImages > 0) {
      content.push({
        type: 'text',
        text: auxiliaryImageAnalysisAvailable
          ? `[该消息包含 ${hiddenImages} 张图片；主模型不直接接收像素，需要时请按消息中的附件 ID 调用 AnalyzeImage。]`
          : `[该消息包含 ${hiddenImages} 张图片；当前模型不支持识图，图片内容不可见。]`,
      })
    }
    return { ...message, content }
  }
  if (message.role !== 'tool') return message
  return {
    ...message,
    content: message.content.map((part): typeof part => {
      if (part.type !== 'tool-result' || part.output.type !== 'content') return part
      const retained: ToolContentOutput['value'] = []
      let hiddenImages = 0
      for (const item of part.output.value) {
        if (isToolImagePart(item)) hiddenImages++
        else retained.push(item)
      }
      if (hiddenImages === 0) return part
      retained.push({
        type: 'text',
        text: auxiliaryImageAnalysisAvailable
          ? `[该工具结果包含 ${hiddenImages} 张图片；主模型不直接接收像素，需要时请按工具结果中的附件 ID 调用 AnalyzeImage。]`
          : `[该工具结果包含 ${hiddenImages} 张图片；当前模型不支持识图，图片内容不可见。]`,
      })
      if (retained.every((item) => item.type === 'text')) {
        return {
          ...part,
          output: {
            type: 'text' as const,
            value: retained.flatMap((item) => item.type === 'text' ? [item.text] : []).join('\n'),
          },
        }
      }
      return { ...part, output: { type: 'content' as const, value: retained } }
    }),
  }
}

/** 返回当前活动模型历史仍直接或间接引用的图片 ID。 */
export function referencedImageAttachmentIds(
  messages: readonly ModelMessage[],
  attachmentMetadata: readonly ImageAttachment[],
): Set<string> {
  const idByStorageName = new Map(
    attachmentMetadata.map((attachment) => [attachment.storageName, attachment.id]),
  )
  const ids = new Set<string>()
  const collectText = (text: string) => {
    for (const id of findImageAttachmentIdReferences(text)) ids.add(id)
  }
  const collectReference = (value: unknown) => {
    if (typeof value !== 'string') return
    const reference = parseImageAttachmentReference(value)
    if (!reference) return
    const id = idByStorageName.get(reference.storageName)
    if (id) ids.add(id)
  }
  for (const message of messages) {
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        collectText(message.content)
        continue
      }
      for (const part of message.content) {
        if (part.type === 'text') collectText(part.text)
        if (part.type === 'file') collectReference(part.data)
      }
      continue
    }
    if (message.role !== 'tool') continue
    for (const part of message.content) {
      if (part.type !== 'tool-result') continue
      if (part.output.type === 'text') collectText(part.output.value)
      if (part.output.type !== 'content') continue
      for (const item of part.output.value) {
        if (item.type === 'text') collectText(item.text)
        if (item.type === 'file' && item.data.type === 'data') {
          collectReference(item.data.data)
        }
      }
    }
  }
  return ids
}

export function imageDeliveryModeFromMessage(
  message: ModelMessage,
): ImageDeliveryMode | null {
  if (message.role !== 'user' || typeof message.content === 'string') return null
  let hasNativeReference = false
  let hasAuxiliaryReference = false
  for (const part of message.content) {
    if (
      part.type === 'text'
      && findImageAttachmentIdReferences(part.text).length > 0
    ) hasAuxiliaryReference = true
    if (
      part.type === 'file'
      && typeof part.data === 'string'
      && parseImageAttachmentReference(part.data)
    ) hasNativeReference = true
  }
  if (hasNativeReference) return 'native'
  return hasAuxiliaryReference ? 'auxiliary' : null
}

function isToolImagePart(part: ToolContentPart): boolean {
  return (part.type === 'file' && part.mediaType.startsWith('image/'))
    || part.type === 'image-data'
    || part.type === 'image-url'
    || part.type === 'image-file-id'
    || part.type === 'image-file-reference'
}
