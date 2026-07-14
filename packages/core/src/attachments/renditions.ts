import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import sharp, { type Metadata } from 'sharp'
import {
  IMAGE_ATTACHMENT_MAX_PIXELS,
  IMAGE_MODEL_MAX_BYTES,
  IMAGE_MODEL_MAX_DIMENSION,
  imageAttachmentSchema,
  type ImageAttachment,
  type ImageMediaType,
} from './types.ts'
import {
  attachmentPath,
  inspectImage,
  readBoundedImageFile,
  readStoredImage,
} from './storage.ts'

const RENDITION_DIRECTORY = '.model-renditions'
const RENDITION_VERSION = 'v1'
const MIN_RENDITION_DIMENSION = 256
const MAX_RESIZE_ATTEMPTS = 5

export interface PreparedImage {
  bytes: Buffer
  mediaType: ImageMediaType
  width: number
  height: number
  optimized: boolean
}

interface EncodePlan {
  format: 'png' | 'jpeg' | 'webp'
  quality?: number
}

/** 保留原图；仅在模型请求边界读取或生成受限的会话级衍生图。 */
export async function prepareImageAttachmentForModel(
  attachmentDirectory: string,
  value: ImageAttachment,
): Promise<PreparedImage> {
  const attachment = imageAttachmentSchema.parse(value)
  const stored = await readStoredImage(attachmentDirectory, attachment.storageName)
  assertStoredMetadata(stored, attachment)
  const cached = await readCachedRendition(attachmentDirectory, attachment)
  if (cached) return cached

  const metadata = await sharp(stored.bytes, {
    failOn: 'warning',
    limitInputPixels: IMAGE_ATTACHMENT_MAX_PIXELS,
  }).metadata()
  const orientation = metadata.orientation ?? 1
  if (
    stored.bytes.byteLength <= IMAGE_MODEL_MAX_BYTES
    && stored.width <= IMAGE_MODEL_MAX_DIMENSION
    && stored.height <= IMAGE_MODEL_MAX_DIMENSION
    && orientation === 1
  ) {
    return { ...stored, optimized: false }
  }

  const generated = await generateRendition(stored.bytes, stored.mediaType, metadata)
  await writeCachedRendition(attachmentDirectory, attachment, generated.bytes)
  return generated
}

/** 丢弃未提交 step 新导入的原图与其衍生图。 */
export async function removeImageAttachmentFiles(
  attachmentDirectory: string,
  attachments: readonly ImageAttachment[],
): Promise<void> {
  await Promise.all(attachments.flatMap((attachment) => [
    rm(attachmentPath(attachmentDirectory, attachment.storageName), { force: true }),
    rm(renditionPath(attachmentDirectory, attachment), { force: true }),
  ]))
}

async function generateRendition(
  source: Buffer,
  mediaType: ImageMediaType,
  metadata: Metadata,
): Promise<PreparedImage> {
  const orientedWidth = orientationSwapsAxes(metadata.orientation) ? metadata.height : metadata.width
  const orientedHeight = orientationSwapsAxes(metadata.orientation) ? metadata.width : metadata.height
  if (!orientedWidth || !orientedHeight) throw new Error('无法读取图片解码尺寸')

  let maxDimension = Math.min(
    IMAGE_MODEL_MAX_DIMENSION,
    Math.max(orientedWidth, orientedHeight),
  )
  const plans = encodePlans(mediaType, metadata.hasAlpha === true)
  for (let attempt = 0; attempt < MAX_RESIZE_ATTEMPTS; attempt++) {
    let smallest: PreparedImage | null = null
    for (const plan of plans) {
      const candidate = await encodeCandidate(source, maxDimension, plan)
      if (!smallest || candidate.bytes.byteLength < smallest.bytes.byteLength) {
        smallest = candidate
      }
      if (candidate.bytes.byteLength <= IMAGE_MODEL_MAX_BYTES) return candidate
    }
    if (!smallest) break
    const ratio = Math.sqrt(IMAGE_MODEL_MAX_BYTES / smallest.bytes.byteLength) * 0.92
    const next = Math.max(
      MIN_RENDITION_DIMENSION,
      Math.floor(maxDimension * Math.min(0.85, ratio)),
    )
    if (next >= maxDimension) break
    maxDimension = next
  }
  throw new Error('图片衍生图仍超过模型输入上限，请手动缩小图片')
}

async function encodeCandidate(
  source: Buffer,
  maxDimension: number,
  plan: EncodePlan,
): Promise<PreparedImage> {
  let pipeline = sharp(source, {
    failOn: 'warning',
    limitInputPixels: IMAGE_ATTACHMENT_MAX_PIXELS,
  })
    .autoOrient()
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
      kernel: sharp.kernel.lanczos3,
    })
    .keepIccProfile()

  if (plan.format === 'png') {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
  } else if (plan.format === 'jpeg') {
    pipeline = pipeline.jpeg({ quality: plan.quality, mozjpeg: true })
  } else {
    pipeline = pipeline.webp({ quality: plan.quality, alphaQuality: 100, effort: 4 })
  }
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
  const inspected = inspectImage(data)
  if (inspected.width !== info.width || inspected.height !== info.height) {
    throw new Error('图片衍生图尺寸校验失败')
  }
  if (
    inspected.width > IMAGE_MODEL_MAX_DIMENSION
    || inspected.height > IMAGE_MODEL_MAX_DIMENSION
  ) {
    throw new Error('图片衍生图超过模型尺寸上限')
  }
  return {
    bytes: data,
    mediaType: inspected.mediaType,
    width: inspected.width,
    height: inspected.height,
    optimized: true,
  }
}

function encodePlans(mediaType: ImageMediaType, hasAlpha: boolean): EncodePlan[] {
  if (mediaType === 'image/png') {
    return hasAlpha
      ? [{ format: 'png' }, ...[90, 78, 66].map((quality) => ({ format: 'webp' as const, quality }))]
      : [{ format: 'png' }, ...[90, 78, 66].map((quality) => ({ format: 'jpeg' as const, quality }))]
  }
  const format = mediaType === 'image/jpeg' ? 'jpeg' : 'webp'
  return [90, 78, 66, 54].map((quality) => ({ format, quality }))
}

async function readCachedRendition(
  attachmentDirectory: string,
  attachment: ImageAttachment,
): Promise<PreparedImage | null> {
  const path = renditionPath(attachmentDirectory, attachment)
  let bytes: Buffer
  try {
    bytes = await readBoundedImageFile(path, IMAGE_MODEL_MAX_BYTES)
  } catch (error) {
    if (isNotFound(error)) return null
    // 有 errno 的失败属于真实文件系统故障；不能伪装成缓存未命中继续执行。
    if (errorCode(error)) throw error
    await rm(path, { force: true }).catch(() => {})
    return null
  }
  try {
    const info = inspectImage(bytes)
    if (info.width > IMAGE_MODEL_MAX_DIMENSION || info.height > IMAGE_MODEL_MAX_DIMENSION) {
      throw new Error('缓存衍生图尺寸超过上限')
    }
    return { bytes, mediaType: info.mediaType, width: info.width, height: info.height, optimized: true }
  } catch {
    await rm(path, { force: true }).catch(() => {})
    return null
  }
}

async function writeCachedRendition(
  attachmentDirectory: string,
  attachment: ImageAttachment,
  bytes: Buffer,
): Promise<void> {
  const directory = renditionDirectory(attachmentDirectory)
  const target = renditionPath(attachmentDirectory, attachment)
  const temporary = join(directory, `${attachment.id}.${randomUUID()}.tmp`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true })
  try {
    await rename(temporary, target)
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

function renditionDirectory(attachmentDirectory: string): string {
  return join(resolve(attachmentDirectory), RENDITION_DIRECTORY)
}

function renditionPath(attachmentDirectory: string, attachment: ImageAttachment): string {
  return join(renditionDirectory(attachmentDirectory), `${attachment.id}.${RENDITION_VERSION}`)
}

function assertStoredMetadata(
  stored: { bytes: Buffer; mediaType: ImageMediaType; width: number; height: number },
  attachment: ImageAttachment,
): void {
  if (
    stored.mediaType !== attachment.mediaType
    || stored.bytes.byteLength !== attachment.byteLength
    || stored.width !== attachment.width
    || stored.height !== attachment.height
  ) {
    throw new Error(`图片附件元数据与磁盘文件不一致：${attachment.storageName}`)
  }
}

function orientationSwapsAxes(orientation: number | undefined): boolean {
  return orientation !== undefined && orientation >= 5 && orientation <= 8
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}
