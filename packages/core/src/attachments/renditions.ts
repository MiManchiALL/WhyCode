import { rm } from 'node:fs/promises'
import sharp, { type Metadata } from 'sharp'
import {
  IMAGE_ATTACHMENT_MAX_PIXELS,
  IMAGE_ATTACHMENT_MAX_SOURCE_BYTES,
  IMAGE_MODEL_MAX_BYTES,
  IMAGE_MODEL_MAX_DIMENSION,
  imageAttachmentSchema,
  imageTransformSchema,
  type ImageAttachment,
  type ImageDetail,
  type ImageMediaType,
  type ImageRegion,
  type ImageTransform,
} from './types.ts'
import {
  attachmentPath,
  inspectImage,
  readStoredImage,
} from './storage.ts'
import {
  IMAGE_PROCESSING_TIMEOUT_SECONDS,
  imageSha256,
  runSharpOperation,
  validateImageDecodes,
} from './decoder.ts'
import {
  readRenditionCache,
  removeRenditionCacheEntry,
  removeRenditionCaches,
  writeRenditionCache,
} from './rendition-cache.ts'

const MIN_RENDITION_DIMENSION = 256
const MAX_RESIZE_ATTEMPTS = 5

export interface PreparedImage {
  bytes: Buffer
  mediaType: ImageMediaType
  width: number
  height: number
  optimized: boolean
  detail: ImageDetail
  /** 坐标均基于 autoOrient 后的源图像素。 */
  sourceWidth: number
  sourceHeight: number
  selectedRegion: ImageRegion
  modelToSourceScaleX: number
  modelToSourceScaleY: number
}

interface EncodePlan {
  format: 'png' | 'jpeg' | 'webp'
  quality?: number
}

type EncodedImage = Pick<
  PreparedImage,
  'bytes' | 'mediaType' | 'width' | 'height' | 'optimized'
>

/** 保留原图；仅在模型请求边界读取或生成受限的会话级衍生图。 */
export async function prepareImageAttachmentForModel(
  attachmentDirectory: string,
  value: ImageAttachment,
  abortSignal?: AbortSignal,
  valueTransform: ImageTransform = { detail: 'high' },
): Promise<PreparedImage> {
  const attachment = imageAttachmentSchema.parse(value)
  const transform = imageTransformSchema.parse(valueTransform)
  const stored = await readStoredImage(attachmentDirectory, attachment.storageName)
  const sourceDigest = imageSha256(stored.bytes)
  assertStoredMetadata(stored, attachment, sourceDigest)
  if (attachment.sha256 === undefined) {
    await validateImageDecodes(stored.bytes, stored, abortSignal)
  }
  const metadata = await readImageMetadata(stored.bytes, abortSignal)
  const orientation = metadata.orientation ?? 1
  const sourceWidth = orientationSwapsAxes(orientation) ? metadata.height : metadata.width
  const sourceHeight = orientationSwapsAxes(orientation) ? metadata.width : metadata.height
  if (!sourceWidth || !sourceHeight) throw new Error('无法读取图片解码尺寸')
  const selectedRegion = resolveSelectedRegion(transform.region, sourceWidth, sourceHeight)

  if (transform.detail === 'original' && !transform.region && orientation === 1) {
    return withMapping({ ...stored, optimized: false }, transform.detail, sourceWidth, sourceHeight, selectedRegion)
  }
  if (
    transform.detail === 'high'
    && !transform.region
    && stored.bytes.byteLength <= IMAGE_MODEL_MAX_BYTES
    && stored.width <= IMAGE_MODEL_MAX_DIMENSION
    && stored.height <= IMAGE_MODEL_MAX_DIMENSION
    && orientation === 1
  ) {
    return withMapping({ ...stored, optimized: false }, transform.detail, sourceWidth, sourceHeight, selectedRegion)
  }

  const variantDigest = imageSha256(Buffer.from(JSON.stringify({ version: 3, transform })))
  const cached = await readCachedRendition(
    attachmentDirectory,
    attachment,
    sourceDigest,
    variantDigest,
    transform.detail,
    selectedRegion,
    abortSignal,
  )
  if (cached) return withMapping(cached, transform.detail, sourceWidth, sourceHeight, selectedRegion)

  const generated = transform.detail === 'original'
    ? await generateOriginalRendition(
        stored.bytes,
        stored.mediaType,
        selectedRegion,
        abortSignal,
      )
    : await generateRendition(
        stored.bytes,
        stored.mediaType,
        metadata,
        selectedRegion,
        abortSignal,
      )
  // 缓存只是可再生优化；缓存目录故障不能丢弃已成功生成的模型输入。
  await writeRenditionCache(
    attachmentDirectory,
    attachment,
    sourceDigest,
    generated.bytes,
    variantDigest,
  ).catch(() => {})
  return withMapping(generated, transform.detail, sourceWidth, sourceHeight, selectedRegion)
}

/** 丢弃未提交 step 新导入的原图与其衍生图。 */
export async function removeImageAttachmentFiles(
  attachmentDirectory: string,
  attachments: readonly ImageAttachment[],
): Promise<void> {
  await Promise.all([
    ...attachments.map((attachment) =>
      rm(attachmentPath(attachmentDirectory, attachment.storageName), { force: true })),
    removeRenditionCaches(attachmentDirectory, attachments),
  ])
}

async function generateRendition(
  source: Buffer,
  mediaType: ImageMediaType,
  metadata: Metadata,
  selectedRegion: ImageRegion,
  abortSignal?: AbortSignal,
): Promise<EncodedImage> {
  let maxDimension = Math.min(
    IMAGE_MODEL_MAX_DIMENSION,
    Math.max(selectedRegion.width, selectedRegion.height),
  )
  const plans = encodePlans(mediaType, metadata.hasAlpha === true)
  for (let attempt = 0; attempt < MAX_RESIZE_ATTEMPTS; attempt++) {
    let smallest: EncodedImage | null = null
    for (const plan of plans) {
      const candidate = await encodeCandidate(
        source,
        selectedRegion,
        maxDimension,
        plan,
        abortSignal,
      )
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
  selectedRegion: ImageRegion,
  maxDimension: number,
  plan: EncodePlan,
  abortSignal?: AbortSignal,
): Promise<EncodedImage> {
  let pipeline = sharp(source, {
    failOn: 'warning',
    limitInputPixels: IMAGE_ATTACHMENT_MAX_PIXELS,
  })
    .autoOrient()
    .extract({
      left: selectedRegion.x,
      top: selectedRegion.y,
      width: selectedRegion.width,
      height: selectedRegion.height,
    })
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
      kernel: sharp.kernel.lanczos3,
    })
    .keepIccProfile()
    .timeout({ seconds: IMAGE_PROCESSING_TIMEOUT_SECONDS })

  if (plan.format === 'png') {
    pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
  } else if (plan.format === 'jpeg') {
    pipeline = pipeline.jpeg({ quality: plan.quality, mozjpeg: true })
  } else {
    pipeline = pipeline.webp({ quality: plan.quality, alphaQuality: 100, effort: 4 })
  }
  const { data, info } = await runSharpOperation(
    pipeline,
    abortSignal,
    () => pipeline.toBuffer({ resolveWithObject: true }),
  )
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

async function generateOriginalRendition(
  source: Buffer,
  mediaType: ImageMediaType,
  selectedRegion: ImageRegion,
  abortSignal?: AbortSignal,
): Promise<EncodedImage> {
  let pipeline = sharp(source, {
    failOn: 'warning',
    limitInputPixels: IMAGE_ATTACHMENT_MAX_PIXELS,
  })
    .autoOrient()
    .extract({
      left: selectedRegion.x,
      top: selectedRegion.y,
      width: selectedRegion.width,
      height: selectedRegion.height,
    })
    .keepIccProfile()
    .timeout({ seconds: IMAGE_PROCESSING_TIMEOUT_SECONDS })
  if (mediaType === 'image/png') pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
  else if (mediaType === 'image/jpeg') pipeline = pipeline.jpeg({ quality: 100, mozjpeg: true })
  else pipeline = pipeline.webp({ quality: 100, alphaQuality: 100, effort: 4 })
  const { data } = await runSharpOperation(
    pipeline,
    abortSignal,
    () => pipeline.toBuffer({ resolveWithObject: true }),
  )
  if (data.byteLength > IMAGE_ATTACHMENT_MAX_SOURCE_BYTES) {
    throw new Error('original 图片变换后超过 20 MB，请改用 high 或缩小区域')
  }
  const inspected = inspectImage(data)
  if (
    inspected.width !== selectedRegion.width
    || inspected.height !== selectedRegion.height
  ) throw new Error('original 图片区域尺寸校验失败')
  return { ...inspected, bytes: data, optimized: true }
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
  sourceDigest: string,
  variantDigest: string,
  detail: ImageDetail,
  selectedRegion: ImageRegion,
  abortSignal?: AbortSignal,
): Promise<EncodedImage | null> {
  const bytes = await readRenditionCache(
    attachmentDirectory,
    attachment,
    sourceDigest,
    variantDigest,
    detail === 'original' ? IMAGE_ATTACHMENT_MAX_SOURCE_BYTES : IMAGE_MODEL_MAX_BYTES,
  )
  if (!bytes) return null
  try {
    const info = inspectImage(bytes)
    if (
      detail === 'high'
      && (info.width > IMAGE_MODEL_MAX_DIMENSION || info.height > IMAGE_MODEL_MAX_DIMENSION)
    ) {
      throw new Error('缓存衍生图尺寸超过上限')
    }
    if (
      detail === 'original'
      && (info.width !== selectedRegion.width || info.height !== selectedRegion.height)
    ) throw new Error('original 缓存区域尺寸不一致')
    await validateImageDecodes(bytes, info, abortSignal)
    return { bytes, mediaType: info.mediaType, width: info.width, height: info.height, optimized: true }
  } catch (error) {
    if (abortSignal?.aborted) throw error
    await removeRenditionCacheEntry(
      attachmentDirectory,
      attachment.id,
      sourceDigest,
      variantDigest,
    ).catch(() => {})
    return null
  }
}

function resolveSelectedRegion(
  region: ImageRegion | undefined,
  sourceWidth: number,
  sourceHeight: number,
): ImageRegion {
  const selected = region ?? { x: 0, y: 0, width: sourceWidth, height: sourceHeight }
  if (
    selected.x + selected.width > sourceWidth
    || selected.y + selected.height > sourceHeight
  ) {
    throw new Error(
      `图片区域超出 autoOrient 后的源图边界 ${sourceWidth}×${sourceHeight}`,
    )
  }
  return selected
}

function withMapping(
  image: EncodedImage,
  detail: ImageDetail,
  sourceWidth: number,
  sourceHeight: number,
  selectedRegion: ImageRegion,
): PreparedImage {
  return {
    ...image,
    detail,
    sourceWidth,
    sourceHeight,
    selectedRegion,
    modelToSourceScaleX: selectedRegion.width / image.width,
    modelToSourceScaleY: selectedRegion.height / image.height,
  }
}

async function readImageMetadata(bytes: Buffer, abortSignal?: AbortSignal): Promise<Metadata> {
  const pipeline = sharp(bytes, {
    failOn: 'warning',
    limitInputPixels: IMAGE_ATTACHMENT_MAX_PIXELS,
  }).timeout({ seconds: IMAGE_PROCESSING_TIMEOUT_SECONDS })
  return runSharpOperation(pipeline, abortSignal, () => pipeline.metadata())
}

function assertStoredMetadata(
  stored: { bytes: Buffer; mediaType: ImageMediaType; width: number; height: number },
  attachment: ImageAttachment,
  sourceDigest: string,
): void {
  if (
    stored.mediaType !== attachment.mediaType
    || stored.bytes.byteLength !== attachment.byteLength
    || stored.width !== attachment.width
    || stored.height !== attachment.height
    || (attachment.sha256 !== undefined && sourceDigest !== attachment.sha256)
  ) {
    throw new Error(`图片附件元数据与磁盘文件不一致：${attachment.storageName}`)
  }
}

function orientationSwapsAxes(orientation: number | undefined): boolean {
  return orientation !== undefined && orientation >= 5 && orientation <= 8
}
