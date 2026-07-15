import type {
  ImageMessageAttachmentInput,
  QueuedUserMessage,
} from '@whycode/core'

interface ImageDraftBase {
  id: string
  name: string
  previewUrl: string
}

export type ImageDraft =
  | (ImageDraftBase & { kind: 'path'; path: string })
  | (ImageDraftBase & { kind: 'memory'; file: File })
  | (ImageDraftBase & { kind: 'stored'; attachmentId: string })

/** UI 预检镜像；安全上限仍由 Core/Main 的同值常量权威执行。 */
export const MAX_IMAGE_DRAFTS = 4
export const MAX_IMAGE_DRAFT_BYTES = 20_000_000

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

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_IMAGE_DRAFT_BYTES) {
    throw new Error('剪贴板图片为空或超过 20 MB')
  }
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)))
  }
  return btoa(chunks.join(''))
}
