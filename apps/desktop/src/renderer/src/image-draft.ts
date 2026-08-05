import type {
  ImageMessageAttachmentInput,
  QueuedUserMessage,
} from '@whycode/core'
import {
  IMAGE_ATTACHMENT_MAX_SOURCE_BYTES,
  USER_IMAGE_ATTACHMENT_MAX_COUNT,
} from '@whycode/core/image-limits'

const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp'])

interface ImageDraftBase {
  id: string
  name: string
  previewUrl: string
}

export type ImageDraft =
  | (ImageDraftBase & { kind: 'path'; path: string })
  | (ImageDraftBase & { kind: 'memory'; file: File })
  | (ImageDraftBase & { kind: 'stored'; attachmentId: string })

/** 保留用户草稿顺序，避免混合选择与粘贴时改变“第几张”的语义。 */
export async function prepareImageDrafts(
  drafts: readonly ImageDraft[],
): Promise<ImageMessageAttachmentInput[]> {
  const inputs: ImageMessageAttachmentInput[] = []
  for (const draft of drafts) {
    if (draft.kind === 'path') inputs.push({ kind: 'path', path: draft.path })
    else if (draft.kind === 'memory') {
      inputs.push({ kind: 'inline', name: draft.name, base64: await fileToBase64(draft.file) })
    } else {
      inputs.push({ kind: 'stored', attachmentId: draft.attachmentId })
    }
  }
  return inputs
}

export function restoredImageDrafts(messages: readonly QueuedUserMessage[]): ImageDraft[] {
  return messages.flatMap((message) => (message.attachments ?? []).map((attachment) => ({
    kind: 'stored' as const,
    id: attachment.id,
    name: attachment.name,
    previewUrl: `whycode-attachment://${attachment.sessionId}/${encodeURIComponent(attachment.storageName)}`,
    attachmentId: attachment.id,
  })))
}

export interface AppendImageDraftResult {
  drafts: ImageDraft[]
  duplicateOrLimit: number
  unsupported: number
  invalidSize: number
}

export function appendImageDrafts(
  current: readonly ImageDraft[],
  files: readonly File[],
): AppendImageDraftResult {
  const result: AppendImageDraftResult = {
    drafts: [...current], duplicateOrLimit: 0, unsupported: 0, invalidSize: 0,
  }
  const knownPaths = new Set(current.flatMap((draft) =>
    draft.kind === 'path' ? [normalizePath(draft.path)] : []))
  const knownMemory = new Set(current.flatMap((draft) =>
    draft.kind === 'memory' ? [draft.file] : []))

  for (const file of files) {
    if (result.drafts.length >= USER_IMAGE_ATTACHMENT_MAX_COUNT) {
      result.duplicateOrLimit++
      continue
    }
    if (file.size <= 0 || file.size > IMAGE_ATTACHMENT_MAX_SOURCE_BYTES) {
      result.invalidSize++
      continue
    }
    const path = getLocalPath(file)
    const normalizedPath = normalizePath(path)
    if (path ? knownPaths.has(normalizedPath) : knownMemory.has(file)) {
      result.duplicateOrLimit++
      continue
    }
    if (!supportsImageFile(file)) {
      result.unsupported++
      continue
    }
    if (path) knownPaths.add(normalizedPath)
    else knownMemory.add(file)
    const previewUrl = URL.createObjectURL(file)
    const base = { id: previewUrl, name: file.name || 'clipboard-image', previewUrl }
    result.drafts.push(path ? { ...base, kind: 'path', path } : { ...base, kind: 'memory', file })
  }
  return result
}

export function formatImageDraftError(result: AppendImageDraftResult): string | null {
  const details: string[] = []
  if (result.duplicateOrLimit) {
    details.push(`重复或超过 ${USER_IMAGE_ATTACHMENT_MAX_COUNT} 张：${result.duplicateOrLimit} 张`)
  }
  if (result.unsupported) details.push(`非 PNG/JPEG/WebP：${result.unsupported} 张`)
  if (result.invalidSize) details.push(`为空或超过 20 MB：${result.invalidSize} 张`)
  return details.length ? `部分图片未添加（${details.join('；')}）` : null
}

export function releaseImageDrafts(drafts: readonly ImageDraft[]): void {
  for (const draft of drafts) releaseImageDraft(draft)
}

function releaseImageDraft(draft: ImageDraft): void {
  if (draft.kind !== 'stored') URL.revokeObjectURL(draft.previewUrl)
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

function getLocalPath(file: File): string {
  try {
    return window.whycode.getPathForFile(file)
  } catch {
    return ''
  }
}

function supportsImageFile(file: File): boolean {
  return SUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase())
    || /\.(?:png|jpe?g|webp)$/i.test(file.name)
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength <= 0 || bytes.byteLength > IMAGE_ATTACHMENT_MAX_SOURCE_BYTES) {
    throw new Error('剪贴板图片为空或超过 20 MB')
  }
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)))
  }
  return btoa(chunks.join(''))
}
