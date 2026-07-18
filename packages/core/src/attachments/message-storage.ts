import type { ModelMessage, ToolResultPart, UserContent } from 'ai'
import { prepareImageAttachmentForModel } from './renditions.ts'
import {
  createImageAttachmentReference,
  DEFAULT_IMAGE_TRANSFORM,
  isImageAttachmentReference,
  parseImageAttachmentReference,
} from './references.ts'
import {
  imageAttachmentSchema,
  imageAttachmentStorageNameSchema,
  type ImageAttachment,
} from './types.ts'

type UserParts = Exclude<UserContent, string>
type UserFilePart = Extract<UserParts[number], { type: 'file' }>
type ToolContentPart = Extract<
  ToolResultPart['output'],
  { type: 'content' }
>['value'][number]
type ToolFilePart = Extract<ToolContentPart, { type: 'file' }>
type UserMessage = Extract<ModelMessage, { role: 'user' }>
type ToolMessage = Extract<ModelMessage, { role: 'tool' }>

export function dehydrateImageMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role === 'user') return dehydrateUserMessage(message)
    if (message.role === 'tool') return dehydrateToolMessage(message)
    return structuredClone(message)
  })
}

export async function hydrateImageMessages(
  messages: readonly ModelMessage[],
  attachmentDirectory: string,
  attachmentMetadata?: readonly ImageAttachment[],
  abortSignal?: AbortSignal,
): Promise<ModelMessage[]> {
  const metadata = indexAttachmentMetadata(attachmentMetadata ?? [])
  const hydrated: ModelMessage[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      hydrated.push(await hydrateUserMessage(
        message, attachmentDirectory, metadata, abortSignal,
      ))
    } else if (message.role === 'tool') {
      hydrated.push(await hydrateToolMessage(
        message, attachmentDirectory, metadata, abortSignal,
      ))
    } else {
      hydrated.push(structuredClone(message))
    }
  }
  return hydrated
}

function dehydrateUserMessage(message: UserMessage): UserMessage {
  if (typeof message.content === 'string') return structuredClone(message)
  return {
    ...message,
    content: message.content.map((part) => {
      if (!isStoredImageFile(part)) return structuredClone(part)
      const existing = typeof part.data === 'string'
        ? parseImageAttachmentReference(part.data)
        : null
      return {
        ...part,
        data: createImageAttachmentReference(
          part.filename,
          existing?.storageName === part.filename
            ? existing.transform
            : DEFAULT_IMAGE_TRANSFORM,
        ),
      }
    }),
  }
}

function dehydrateToolMessage(message: ToolMessage): ToolMessage {
  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type !== 'tool-result' || part.output.type !== 'content') {
        return structuredClone(part)
      }
      return {
        ...part,
        output: {
          ...part.output,
          value: part.output.value.map((item) => {
            if (!isStoredToolImageFile(item)) return structuredClone(item)
            const existing = typeof item.data.data === 'string'
              ? parseImageAttachmentReference(item.data.data)
              : null
            return {
              ...item,
              data: {
                type: 'data' as const,
                data: createImageAttachmentReference(
                  item.filename,
                  existing?.storageName === item.filename
                    ? existing.transform
                    : DEFAULT_IMAGE_TRANSFORM,
                ),
              },
            }
          }),
        },
      }
    }),
  }
}

async function hydrateUserMessage(
  message: UserMessage,
  directory: string,
  metadata: ReadonlyMap<string, ImageAttachment>,
  abortSignal?: AbortSignal,
): Promise<UserMessage> {
  if (typeof message.content === 'string') return structuredClone(message)
  const content: typeof message.content = []
  for (const part of message.content) {
    if (part.type !== 'file' || typeof part.data !== 'string') {
      content.push(structuredClone(part))
      continue
    }
    const prepared = await hydrateReference(
      part.data, part.filename, part.mediaType, directory, metadata, abortSignal,
    )
    content.push(prepared
      ? { ...part, data: prepared.data, mediaType: prepared.mediaType }
      : structuredClone(part))
  }
  return { ...message, content }
}

async function hydrateToolMessage(
  message: ToolMessage,
  directory: string,
  metadata: ReadonlyMap<string, ImageAttachment>,
  abortSignal?: AbortSignal,
): Promise<ToolMessage> {
  const content: typeof message.content = []
  for (const part of message.content) {
    if (part.type !== 'tool-result' || part.output.type !== 'content') {
      content.push(structuredClone(part))
      continue
    }
    const value: typeof part.output.value = []
    for (const item of part.output.value) {
      if (
        item.type !== 'file'
        || item.data.type !== 'data'
        || typeof item.data.data !== 'string'
      ) {
        value.push(structuredClone(item))
        continue
      }
      const prepared = await hydrateReference(
        item.data.data, item.filename, item.mediaType, directory, metadata, abortSignal,
      )
      value.push(prepared
        ? {
            ...item,
            data: { type: 'data', data: prepared.data },
            mediaType: prepared.mediaType,
          }
        : structuredClone(item))
    }
    content.push({ ...part, output: { ...part.output, value } })
  }
  return { ...message, content }
}

export function hasStoredImageReferences(messages: readonly ModelMessage[]): boolean {
  return messages.some((message) => {
    if (message.role === 'user' && typeof message.content !== 'string') {
      return message.content.some((part) =>
        part.type === 'file'
        && typeof part.data === 'string'
        && isImageAttachmentReference(part.data))
    }
    if (message.role !== 'tool') return false
    return message.content.some((part) =>
      part.type === 'tool-result'
      && part.output.type === 'content'
      && part.output.value.some((item) =>
        item.type === 'file'
        && item.data.type === 'data'
        && typeof item.data.data === 'string'
        && isImageAttachmentReference(item.data.data)))
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

function isStoredImageFile(
  part: UserParts[number],
): part is UserFilePart & { filename: string } {
  return part.type === 'file'
    && part.mediaType.startsWith('image/')
    && typeof part.filename === 'string'
    && imageAttachmentStorageNameSchema.safeParse(part.filename).success
}

function isStoredToolImageFile(
  part: ToolContentPart,
): part is ToolFilePart & {
  filename: string
  data: Extract<ToolFilePart['data'], { type: 'data' }>
} {
  return part.type === 'file'
    && part.mediaType.startsWith('image/')
    && part.data.type === 'data'
    && typeof part.filename === 'string'
    && imageAttachmentStorageNameSchema.safeParse(part.filename).success
}

async function hydrateReference(
  rawData: string,
  filename: string | undefined,
  mediaType: string,
  attachmentDirectory: string,
  metadata: ReadonlyMap<string, ImageAttachment>,
  abortSignal?: AbortSignal,
): Promise<{ data: string; mediaType: string } | null> {
  const reference = parseImageAttachmentReference(rawData)
  if (!reference) return null
  if (filename !== reference.storageName) throw new Error('图片附件引用与文件名不一致')
  const expected = metadata.get(reference.storageName)
  if (!expected) throw new Error('图片附件引用缺少权威元数据')
  if (expected.mediaType !== mediaType) throw new Error('图片附件媒体类型不一致')
  const prepared = await prepareImageAttachmentForModel(
    attachmentDirectory,
    expected,
    abortSignal,
    reference.transform,
  )
  return { data: prepared.bytes.toString('base64'), mediaType: prepared.mediaType }
}
