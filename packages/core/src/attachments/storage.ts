import { randomUUID } from 'node:crypto'
import { mkdir, open, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  IMAGE_ATTACHMENT_MAX_BYTES,
  IMAGE_ATTACHMENT_MAX_COUNT,
  IMAGE_ATTACHMENT_MAX_DIMENSION,
  IMAGE_ATTACHMENT_MAX_PIXELS,
  imageAttachmentSchema,
  imageAttachmentStorageNameSchema,
  type ImageAttachment,
  type ImageMediaType,
} from './types.ts'

interface ImageInfo {
  mediaType: ImageMediaType
  extension: 'png' | 'jpg' | 'webp'
  width: number
  height: number
}

export async function importImageAttachments(
  sourcePaths: readonly string[],
  attachmentDirectory: string,
  sessionId: string,
): Promise<ImageAttachment[]> {
  if (sourcePaths.length === 0) return []
  if (sourcePaths.length > IMAGE_ATTACHMENT_MAX_COUNT) {
    throw new Error(`每条消息最多添加 ${IMAGE_ATTACHMENT_MAX_COUNT} 张图片`)
  }
  if (new Set(sourcePaths.map(normalizeLocalPath)).size !== sourcePaths.length) {
    throw new Error('同一张图片不能重复添加')
  }

  const directory = resolve(attachmentDirectory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const written: string[] = []
  const attachments: ImageAttachment[] = []
  try {
    for (const sourcePath of sourcePaths) {
      const bytes = await readBoundedFile(sourcePath)
      const info = inspectImage(bytes)
      const id = randomUUID()
      const storageName = `${id}.${info.extension}`
      const target = attachmentPath(directory, storageName)
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600, flush: true })
      written.push(target)
      attachments.push(imageAttachmentSchema.parse({
        id,
        sessionId,
        name: safeDisplayName(sourcePath),
        storageName,
        mediaType: info.mediaType,
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
  const bytes = await readBoundedFile(attachmentPath(attachmentDirectory, storageName))
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
  if (
    stored.mediaType !== parsed.mediaType
    || stored.bytes.byteLength !== parsed.byteLength
    || stored.width !== parsed.width
    || stored.height !== parsed.height
  ) {
    throw new Error(`图片附件元数据与磁盘文件不一致：${parsed.storageName}`)
  }
}

export function attachmentPath(attachmentDirectory: string, storageName: string): string {
  const safeName = imageAttachmentStorageNameSchema.parse(storageName)
  return join(resolve(attachmentDirectory), safeName)
}

export function inspectImage(bytes: Buffer): ImageInfo {
  let info: ImageInfo | null = null
  if (isPng(bytes)) info = pngInfo(bytes)
  else if (isJpeg(bytes)) info = jpegInfo(bytes)
  else if (isWebp(bytes)) info = webpInfo(bytes)
  if (!info) throw new Error('只支持真实的 PNG、JPEG 或 WebP 图片')
  validateDimensions(info.width, info.height)
  return info
}

async function readBoundedFile(path: string): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error(`附件不是普通文件：${path}`)
    if (stat.size <= 0) throw new Error(`图片文件为空：${path}`)
    if (stat.size > IMAGE_ATTACHMENT_MAX_BYTES) {
      throw new Error(`图片不能超过 ${(IMAGE_ATTACHMENT_MAX_BYTES / 1_000_000).toFixed(2)} MB：${basename(path)}`)
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

function validateDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('图片尺寸无效')
  }
  if (
    width > IMAGE_ATTACHMENT_MAX_DIMENSION
    || height > IMAGE_ATTACHMENT_MAX_DIMENSION
    || width * height > IMAGE_ATTACHMENT_MAX_PIXELS
  ) {
    throw new Error(
      `图片分辨率过大（${width}×${height}）；请缩小到 ${IMAGE_ATTACHMENT_MAX_PIXELS / 1_000_000} 百万像素以内`,
    )
  }
}

function isPng(bytes: Buffer): boolean {
  return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
}

function pngInfo(bytes: Buffer): ImageInfo | null {
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  return { mediaType: 'image/png', extension: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function jpegInfo(bytes: Buffer): ImageInfo | null {
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
  let offset = 2
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset++
      continue
    }
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue
    if (offset + 1 >= bytes.length) break
    const segmentLength = bytes.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break
    if (startOfFrame.has(marker) && segmentLength >= 7) {
      return {
        mediaType: 'image/jpeg',
        extension: 'jpg',
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      }
    }
    offset += segmentLength
  }
  return null
}

function isWebp(bytes: Buffer): boolean {
  return bytes.length >= 30
    && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP'
}

function webpInfo(bytes: Buffer): ImageInfo | null {
  const chunk = bytes.toString('ascii', 12, 16)
  if (chunk === 'VP8X') {
    return {
      mediaType: 'image/webp',
      extension: 'webp',
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    }
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const b1 = bytes[21]!
    const b2 = bytes[22]!
    const b3 = bytes[23]!
    const b4 = bytes[24]!
    return {
      mediaType: 'image/webp',
      extension: 'webp',
      width: 1 + b1 + ((b2 & 0x3f) << 8),
      height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
    }
  }
  if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      mediaType: 'image/webp',
      extension: 'webp',
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    }
  }
  return null
}

function safeDisplayName(path: string): string {
  const cleaned = basename(path).replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'image'
  return cleaned.slice(0, 255)
}

function normalizeLocalPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
