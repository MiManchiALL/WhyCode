import type { ModelMessage, ToolResultPart } from 'ai'
import {
  dehydrateImageMessages,
  hasStoredImageReferences,
  hydrateImageMessages,
} from './message-storage.ts'
import { createImageAttachmentReference } from './references.ts'
import type { ImageAttachment } from './types.ts'

type ToolContentOutput = Extract<ToolResultPart['output'], { type: 'content' }>
type ToolContentPart = ToolContentOutput['value'][number]

export { dehydrateImageMessages, hydrateImageMessages }

export function createImageUserMessage(
  text: string,
  attachments: readonly ImageAttachment[],
): ModelMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      ...attachments.flatMap((attachment, index) => [
        { type: 'text' as const, text: `[图片 ${index + 1}：${attachment.name}]` },
        {
          type: 'file' as const,
          data: createImageAttachmentReference(attachment.storageName),
          filename: attachment.storageName,
          mediaType: attachment.mediaType,
        },
      ]),
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
): Promise<ModelMessage[]> {
  if (!supportsImageInput) return messages.map(stripImagesForNonVisualModel)
  if (!hasStoredImageReferences(messages)) return [...messages]
  if (!attachmentDirectory) throw new Error('视觉模型请求缺少会话附件目录')
  return hydrateImageMessages(
    messages,
    attachmentDirectory,
    attachmentMetadata,
    abortSignal,
  )
}

function stripImagesForNonVisualModel(message: ModelMessage): ModelMessage {
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
        text: `[该消息包含 ${hiddenImages} 张图片；当前模型不支持识图，图片内容不可见。]`,
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
        text: `[该工具结果包含 ${hiddenImages} 张图片；当前模型不支持识图，图片内容不可见。]`,
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

function isToolImagePart(part: ToolContentPart): boolean {
  return (part.type === 'file' && part.mediaType.startsWith('image/'))
    || part.type === 'image-data'
    || part.type === 'image-url'
    || part.type === 'image-file-id'
    || part.type === 'image-file-reference'
}
