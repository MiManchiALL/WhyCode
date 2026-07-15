import {
  IMAGE_ATTACHMENT_MAX_DIMENSION,
  IMAGE_ATTACHMENT_MAX_PIXELS,
  type ImageMediaType,
} from './types.ts'

export interface ImageInfo {
  mediaType: ImageMediaType
  extension: 'png' | 'jpg' | 'webp'
  width: number
  height: number
}

/** 只读取格式与尺寸，作为完整解码前的廉价边界预检。 */
export function inspectImage(bytes: Buffer): ImageInfo {
  let info: ImageInfo | null = null
  if (isPng(bytes)) info = pngInfo(bytes)
  else if (isJpeg(bytes)) info = jpegInfo(bytes)
  else if (isWebp(bytes)) info = webpInfo(bytes)
  if (!info) throw new Error('只支持真实的 PNG、JPEG 或 WebP 图片')
  validateDimensions(info.width, info.height)
  return info
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
  return bytes.length >= 24
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
}

function pngInfo(bytes: Buffer): ImageInfo | null {
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  return {
    mediaType: 'image/png',
    extension: 'png',
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  }
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function jpegInfo(bytes: Buffer): ImageInfo | null {
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ])
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
