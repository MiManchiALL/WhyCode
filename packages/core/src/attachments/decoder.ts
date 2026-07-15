import { createHash } from 'node:crypto'
import sharp, { type Metadata, type Sharp } from 'sharp'
import { IMAGE_ATTACHMENT_MAX_PIXELS, type ImageMediaType } from './types.ts'

export const IMAGE_PROCESSING_TIMEOUT_SECONDS = 30

export interface ExpectedImageInfo {
  mediaType: ImageMediaType
  width: number
  height: number
}

export function imageSha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 文件头只做廉价预检；像素统计会强制 libvips 完整解码，且不在 JS 中保留展开后的像素缓冲区。 */
export async function validateImageDecodes(
  bytes: Buffer,
  expected: ExpectedImageInfo,
  abortSignal?: AbortSignal,
): Promise<Metadata> {
  const pipeline = sharp(bytes, {
    failOn: 'warning',
    limitInputPixels: IMAGE_ATTACHMENT_MAX_PIXELS,
  }).timeout({ seconds: IMAGE_PROCESSING_TIMEOUT_SECONDS })

  try {
    const metadata = await runSharpOperation(pipeline, abortSignal, () => pipeline.metadata())
    assertDecodedMetadata(metadata, expected)
    await runSharpOperation(pipeline, abortSignal, () => pipeline.stats())
    return metadata
  } catch (error) {
    if (abortSignal?.aborted) throw new Error('图片处理已取消', { cause: error })
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`图片无法完整解码，文件可能损坏或不完整：${detail}`, { cause: error })
  }
}

export async function runSharpOperation<T>(
  pipeline: Sharp,
  abortSignal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (abortSignal?.aborted) throw new Error('图片处理已取消')
  const abort = () => pipeline.destroy(new Error('图片处理已取消'))
  abortSignal?.addEventListener('abort', abort, { once: true })
  try {
    return await operation()
  } finally {
    abortSignal?.removeEventListener('abort', abort)
  }
}

function assertDecodedMetadata(metadata: Metadata, expected: ExpectedImageInfo): void {
  const decodedMediaType = metadata.format === 'jpeg'
    ? 'image/jpeg'
    : metadata.format === 'png'
      ? 'image/png'
      : metadata.format === 'webp'
        ? 'image/webp'
        : null
  if (
    decodedMediaType !== expected.mediaType
    || metadata.width !== expected.width
    || metadata.height !== expected.height
  ) {
    throw new Error('图片头部信息与完整解码结果不一致')
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new Error('暂不支持动态或多帧图片')
  }
}
