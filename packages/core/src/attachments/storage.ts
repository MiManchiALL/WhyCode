import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises'
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

export interface ImageAttachmentImportTransaction {
  readonly attachments: readonly ImageAttachment[]
  commit(): Promise<void>
  rollback(): Promise<void>
}

export type ImageImportSource = ImageAttachmentInput | {
  kind: 'bytes'
  name: string
  bytes: Uint8Array
}

export async function importImageAttachments(
  sources: readonly ImageImportSource[],
  attachmentDirectory: string,
  sessionId: string,
  abortSignal?: AbortSignal,
): Promise<ImageAttachment[]> {
  const transaction = await prepareImageAttachmentImport(
    sources,
    attachmentDirectory,
    sessionId,
    abortSignal,
  )
  await transaction.commit()
  return [...transaction.attachments]
}

export async function prepareImageAttachmentImport(
  sources: readonly ImageImportSource[],
  attachmentDirectory: string,
  sessionId: string,
  abortSignal?: AbortSignal,
): Promise<ImageAttachmentImportTransaction> {
  if (sources.length === 0) {
    return {
      attachments: [],
      commit: async () => {},
      rollback: async () => {},
    }
  }
  if (sources.length > IMAGE_ATTACHMENT_MAX_COUNT) {
    throw new Error(`每条消息最多添加 ${IMAGE_ATTACHMENT_MAX_COUNT} 张图片`)
  }
  const sourcePaths = sources.flatMap((source) => source.kind === 'path' ? [source.path] : [])
  if (new Set(sourcePaths.map(normalizeLocalPath)).size !== sourcePaths.length) {
    throw new Error('同一张图片不能重复添加')
  }

  const directory = resolve(attachmentDirectory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stagingDirectory = join(directory, `.image-import-${randomUUID()}`)
  await mkdir(stagingDirectory, { mode: 0o700 })
  const attachments: ImageAttachment[] = []
  const seenDigests = new Set<string>()
  try {
    for (const source of sources) {
      throwIfImageImportAborted(abortSignal)
      const bytes = source.kind === 'path'
        ? await readBoundedImageFile(source.path)
        : source.kind === 'inline'
          ? decodeInlineImage(source)
          : boundedImageBytes(source.bytes)
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
      await writeFile(join(stagingDirectory, storageName), bytes, {
        flag: 'wx',
        mode: 0o600,
        flush: true,
      })
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
    return createImportTransaction(directory, stagingDirectory, attachments)
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/** 会话事实源加载完成后清除 staging 与不再被任何元数据引用的原图。 */
export async function cleanupUnreferencedImageAttachments(
  attachmentDirectory: string,
  attachments: readonly ImageAttachment[],
): Promise<void> {
  const allowed = new Set(attachments.map((attachment) => attachment.storageName))
  const entries = await readdir(resolve(attachmentDirectory), { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    },
  )
  await Promise.all(entries.flatMap((entry) => {
    const path = join(resolve(attachmentDirectory), entry.name)
    if (entry.isDirectory() && entry.name.startsWith('.image-import-')) {
      return [rm(path, { recursive: true, force: true })]
    }
    if (
      entry.isFile()
      && imageAttachmentStorageNameSchema.safeParse(entry.name).success
      && !allowed.has(entry.name)
    ) return [rm(path, { force: true })]
    return []
  }))
}

function createImportTransaction(
  directory: string,
  stagingDirectory: string,
  attachments: ImageAttachment[],
): ImageAttachmentImportTransaction {
  let state: 'prepared' | 'committed' | 'rolled-back' = 'prepared'
  const committedPaths: string[] = []
  return {
    attachments,
    async commit() {
      if (state === 'committed') return
      if (state === 'rolled-back') throw new Error('图片导入事务已回滚')
      try {
        for (const attachment of attachments) {
          const target = attachmentPath(directory, attachment.storageName)
          await rename(join(stagingDirectory, attachment.storageName), target)
          committedPaths.push(target)
        }
        await rm(stagingDirectory, { recursive: true, force: true })
        state = 'committed'
      } catch (error) {
        await Promise.all(committedPaths.map((path) => rm(path, { force: true }).catch(() => {})))
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
        state = 'rolled-back'
        throw error
      }
    },
    async rollback() {
      if (state === 'rolled-back') return
      await Promise.all(committedPaths.map((path) => rm(path, { force: true }).catch(() => {})))
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
      state = 'rolled-back'
    },
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

function boundedImageBytes(value: Uint8Array): Buffer {
  const bytes = Buffer.from(value)
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
