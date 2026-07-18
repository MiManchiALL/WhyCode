import type { ModelMessage, ToolResultPart } from 'ai'
import { createImageAttachmentReference } from './references.ts'
import type { ImageAttachment, ImageTransform } from './types.ts'

export interface ImageToolResult {
  toolCallId: string
  attachments: readonly ImageAttachment[]
  transform: ImageTransform
}

/** 把视觉字节绑定到原始 tool_call_id；持久历史不再伪造 user 消息。 */
export function attachImagesToToolResults(
  messages: readonly ModelMessage[],
  imageResults: readonly ImageToolResult[],
): ModelMessage[] {
  if (imageResults.length === 0) return [...messages]
  const pending = new Map<string, ImageToolResult>()
  for (const result of imageResults) {
    if (pending.has(result.toolCallId)) {
      throw new Error(`图片工具结果重复：${result.toolCallId}`)
    }
    pending.set(result.toolCallId, result)
  }

  const attached = new Set<string>()
  const output = messages.map((message): ModelMessage => {
    if (message.role !== 'tool') return message
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== 'tool-result') return part
        const imageResult = pending.get(part.toolCallId)
        if (!imageResult) return part
        if (attached.has(part.toolCallId)) {
          throw new Error(`工具结果 ID 不唯一：${part.toolCallId}`)
        }
        attached.add(part.toolCallId)
        return withImages(part, imageResult)
      }),
    }
  })

  const missing = [...pending.keys()].filter((toolCallId) => !attached.has(toolCallId))
  if (missing.length > 0) {
    throw new Error(`找不到图片对应的工具结果：${missing.join(', ')}`)
  }
  return output
}

function withImages(part: ToolResultPart, result: ImageToolResult): ToolResultPart {
  const existing = part.output.type === 'content'
    ? part.output.value
    : [{ type: 'text' as const, text: toolOutputText(part.output) }]
  return {
    ...part,
    output: {
      type: 'content',
      value: [
        ...existing,
        ...result.attachments.flatMap((attachment, index) => [
          {
            type: 'text' as const,
            text: `[视觉工具结果 ${index + 1}：${attachment.name}]`,
          },
          {
            type: 'file' as const,
            data: {
              type: 'data' as const,
              data: createImageAttachmentReference(attachment.storageName, result.transform),
            },
            filename: attachment.storageName,
            mediaType: attachment.mediaType,
          },
        ]),
      ],
    },
  }
}

function toolOutputText(output: ToolResultPart['output']): string {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return output.value
    case 'execution-denied':
      return output.reason ?? '工具调用被拒绝。'
    case 'json':
    case 'error-json':
      return JSON.stringify(output.value)
    case 'content':
      return output.value.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
  }
}
