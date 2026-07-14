import { randomUUID } from 'node:crypto'
import { mkdir, open, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  IMAGE_ATTACHMENT_MAX_COUNT,
  IMAGE_ATTACHMENT_MAX_SOURCE_BYTES,
  imageAttachmentSchema,
  imageAttachmentStorageNameSchema,
  type ImageAttachment,
  type ImageAttachmentInput,
  type ImageMediaType,
} from './types.ts'
import { imageSha256, validateImageDecodes } from './decoder.ts'
import { inspectImage } from './inspection.ts'

export { inspectImage } from './inspection.ts'

export async function importImageAttachments(
  sources: readonly ImageAttachmentInput[],
  attachmentDirectory: string,
  sessionId: string,
  abortSignal?: AbortSignal,
): Promise<ImageAttachment[]> {
  if (sources.length === 0) return []
  if (sources.length > IMAGE_ATTACHMENT_MAX_COUNT) {
    throw new Error(`每条消息最多添加 ${IMAGE_ATTACHMENT_MAX_COUNT} 张图片`)
  }
  const sourcePaths = sources.flatMap((source) => source.kind === 'path' ? [source.path] : [])
  if (new Set(sourcePaths.map(normalizeLocalPath)).size !== sourcePaths.length) {
    throw new Error('同一张图片不能重复添加')
  }

  const directory = resolve(attachmentDirectory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const written: string[] = []
  const attachments: ImageAttachment[] = []
  const seenDigests = new Set<string>()
  try {
    for (const source of sources) {
      throwIfImageImportAborted(abortSignal)
      const bytes = source.kind === 'path'
        ? await readBoundedImageFile(source.path)
        : decodeInlineImage(source)
      const digest = imageSha256(bytes)
      if (seenDigests.has(digest)) {
        throw new Error('同一张图片不能重复添加')
      }
      seenDigests.add(digest)
      const info = inspectImage(bytes)
      await validateImageDecodes(bytes, info, abortSignal)
      throwIfImageImportAborted(abortSignal)
      const id = randomUUID()
      const storageName = `${id}.${info.extension}`
      const target = attachmentPath(directory, storageName)
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600, flush: true })
      written.push(target)
      attachments.push(imageAttachmentSchema.parse({
        id,
        sessionId,
        name: safeDisplayName(
          source.kind === 'path' ? source.path : source.name,
        ),
        storageName,
        mediaType: info.mediaType,
        sha256: digest,
        byteLength: bytes.byteLength,
        width: info.width,
        height: info.height,
      }))
    }
    return attachments
  } catch (error) {
    await Promise.all(written.map((path) => rm(path, { force: true }).catch(() => {})))
    throw error
  }
}

export async function readStoredImage(
  attachmentDirectory: string,
  storageName: string,
): Promise<{ bytes: Buffer; mediaType: ImageMediaType; width: number; height: number }> {
  const bytes = await readBoundedImageFile(attachmentPath(attachmentDirectory, storageName))
  const info = inspectImage(bytes)
  if (info.extension !== storageName.slice(storageName.lastIndexOf('.') + 1).toLowerCase()) {
    throw new Error(`图片附件格式与存储名不一致：${storageName}`)
  }
  return { bytes, mediaType: info.mediaType, width: info.width, height: info.height }
}

/** 恢复会话时不信任 JSONL 元数据；归属、重复记录和磁盘字节必须完全一致。 */
export async function validateStoredImageAttachments(
  attachmentDirectory: string,
  sessionId: string,
  attachments: readonly ImageAttachment[],
): Promise<void> {
  const unique = new Map<string, { serialized: string; attachment: ImageAttachment }>()
  for (const attachment of attachments) {
    if (attachment.sessionId !== sessionId) throw new Error('图片附件不属于当前会话')
    const serialized = JSON.stringify(attachment)
    const previous = unique.get(attachment.storageName)
    if (previous && previous.serialized !== serialized) {
      throw new Error(`同一图片附件存在冲突元数据：${attachment.storageName}`)
    }
    if (!previous) unique.set(attachment.storageName, { serialized, attachment })
  }
  for (const { attachment } of unique.values()) {
    await validateStoredImageAttachment(attachmentDirectory, attachment)
  }
}

async function validateStoredImageAttachment(
  attachmentDirectory: string,
  attachment: ImageAttachment,
): Promise<void> {
  const parsed = imageAttachmentSchema.parse(attachment)
  const stored = await readStoredImage(attachmentDirectory, parsed.storageName)
  await validateImageDecodes(stored.bytes, stored)
  if (
    stored.mediaType !== parsed.mediaType
    || stored.bytes.byteLength !== parsed.byteLength
    || stored.width !== parsed.width
    || stored.height !== parsed.height
    || (parsed.sha256 !== undefined && imageSha256(stored.bytes) !== parsed.sha256)
  ) {
    throw new Error(`图片附件元数据与磁盘文件不一致：${parsed.storageName}`)
  }
}

function throwIfImageImportAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted) throw new Error('图片处理已取消')
}

export function attachmentPath(attachmentDirectory: string, storageName: string): string {
  const safeName = imageAttachmentStorageNameSchema.parse(storageName)
  return join(resolve(attachmentDirectory), safeName)
}

export async function readBoundedImageFile(
  path: string,
  maxBytes = IMAGE_ATTACHMENT_MAX_SOURCE_BYTES,
): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error(`附件不是普通文件：${path}`)
    if (stat.size <= 0) throw new Error(`图片文件为空：${path}`)
    if (stat.size > maxBytes) {
      throw new Error(`图片不能超过 ${(maxBytes / 1_000_000).toFixed(2)} MB：${basename(path)}`)
    }
    const bytes = Buffer.alloc(Number(stat.size))
    let offset = 0
    while (offset < bytes.byteLength) {
      const { bytesRead } = await file.read(bytes, offset, bytes.byteLength - offset, offset)
      if (bytesRead === 0) throw new Error(`读取图片时文件发生变化：${path}`)
      offset += bytesRead
    }
    return bytes
  } finally {
    await file.close()
  }
}

function decodeInlineImage(input: Extract<ImageAttachmentInput, { kind: 'inline' }>): Buffer {
  if (!input || typeof input.name !== 'string' || typeof input.base64 !== 'string') {
    throw new Error('内存图片数据无效')
  }
  const maxBase64Length = 4 * Math.ceil(IMAGE_ATTACHMENT_MAX_SOURCE_BYTES / 3)
  if (
    input.base64.length === 0
    || input.base64.length > maxBase64Length
    || input.base64.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)
  ) {
    throw new Error('内存图片编码无效或超过大小上限')
  }
  const bytes = Buffer.from(input.base64, 'base64')
  if (bytes.toString('base64') !== input.base64) {
    throw new Error('内存图片编码无效或超过大小上限')
  }
  if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_ATTACHMENT_MAX_SOURCE_BYTES) {
    throw new Error(`图片不能超过 ${(IMAGE_ATTACHMENT_MAX_SOURCE_BYTES / 1_000_000).toFixed(2)} MB`)
  }
  return bytes
}

function safeDisplayName(path: string): string {
  const cleaned = basename(path).replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'image'
  return cleaned.slice(0, 255)
}

function normalizeLocalPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
