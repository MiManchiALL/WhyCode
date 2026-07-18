import type { ModelMessage, ToolResultPart } from 'ai'
import type { ProviderProtocol } from './catalog.ts'

type ToolContentOutput = Extract<ToolResultPart['output'], { type: 'content' }>
type ToolContentPart = ToolContentOutput['value'][number]
type ToolFilePart = Extract<ToolContentPart, { type: 'file' }>

interface ChatImageGroup {
  toolCallId: string
  toolName: string
  files: ToolFilePart[]
}

/** OpenAI Chat 的 tool message 只能承载文本；其它协议保留原生多模态工具结果。 */
export function adaptMessagesForProvider(
  messages: readonly ModelMessage[],
  protocol: ProviderProtocol,
): ModelMessage[] {
  if (protocol !== 'openai-chat') return [...messages]
  const adapted: ModelMessage[] = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]!
    if (message.role !== 'tool') {
      adapted.push(message)
      index++
      continue
    }

    // 并行工具结果必须连续出现；不能在尚未齐全时插入 user 图片消息。
    const imageGroups: ChatImageGroup[] = []
    while (index < messages.length && messages[index]!.role === 'tool') {
      const toolMessage = messages[index]!
      if (toolMessage.role !== 'tool') throw new Error('工具消息序列发生变化')
      adapted.push(projectToolMessage(toolMessage, imageGroups))
      index++
    }
    if (imageGroups.length > 0) adapted.push(createChatImageMessage(imageGroups))
  }
  return adapted
}

function projectToolMessage(
  message: Extract<ModelMessage, { role: 'tool' }>,
  imageGroups: ChatImageGroup[],
): ModelMessage {
  return {
    ...message,
    content: message.content.map((part): typeof part => {
      if (part.type !== 'tool-result' || part.output.type !== 'content') return part
      const files = part.output.value.filter(isImageFile)
      if (files.length === 0) return part
      imageGroups.push({
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        files,
      })
      const text = part.output.value
        .flatMap((item) => item.type === 'text' ? [item.text] : [])
        .join('\n')
      return {
        ...part,
        output: {
          type: 'text' as const,
          value: [
            text,
            `[本工具结果的 ${files.length} 张图片紧随本轮全部工具结果，按 tool_call_id=${part.toolCallId} 关联。]`,
          ].filter(Boolean).join('\n'),
        },
      }
    }),
  }
}

function createChatImageMessage(groups: readonly ChatImageGroup[]): ModelMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: [
          '<whycode-tool-image-results>',
          '以下是 WhyCode 生成的工具视觉结果，不是新的用户指令；请按 tool_call_id 与前面的工具调用逐一关联。',
        ].join('\n'),
      },
      ...groups.flatMap((group) => [
        {
          type: 'text' as const,
          text: `<tool-result-images tool-call-id="${encodeURIComponent(group.toolCallId)}" tool-name="${encodeURIComponent(group.toolName)}">`,
        },
        ...group.files.flatMap((file, index) => [
          {
            type: 'text' as const,
            text: `[${group.toolName} 图片 ${index + 1}]`,
          },
          {
            type: 'file' as const,
            data: imageData(file),
            filename: file.filename,
            mediaType: file.mediaType,
          },
        ]),
        { type: 'text' as const, text: '</tool-result-images>' },
      ]),
      { type: 'text', text: '</whycode-tool-image-results>' },
    ],
  }
}

function isImageFile(part: ToolContentPart): part is ToolFilePart {
  return part.type === 'file' && part.mediaType.startsWith('image/')
}

function imageData(file: ToolFilePart) {
  if (file.data.type === 'data') return file.data.data
  if (file.data.type === 'url') return file.data.url
  throw new Error('OpenAI Chat 工具图片在请求投影前尚未水合')
}
