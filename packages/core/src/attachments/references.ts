import { imageAttachmentStorageNameSchema, type ImageTransform } from './types.ts'

const ATTACHMENT_REF_V1_PREFIX = 'whycode-attachment-ref:v1:'
const ATTACHMENT_REF_V2_PREFIX = 'whycode-attachment-ref:v2:'
export const DEFAULT_IMAGE_TRANSFORM: ImageTransform = { detail: 'high' }

export function createImageAttachmentReference(
  storageName: string,
  transform: ImageTransform = DEFAULT_IMAGE_TRANSFORM,
): string {
  const safeName = imageAttachmentStorageNameSchema.parse(storageName)
  if (transform.detail === 'high' && !transform.region) {
    return `${ATTACHMENT_REF_V1_PREFIX}${safeName}`
  }
  const region = transform.region
    ? `${transform.region.x},${transform.region.y},${transform.region.width},${transform.region.height}`
    : '-'
  return `${ATTACHMENT_REF_V2_PREFIX}${safeName}:${transform.detail}:${region}`
}

export function parseImageAttachmentReference(
  value: string,
): { storageName: string; transform: ImageTransform } | null {
  if (value.startsWith(ATTACHMENT_REF_V1_PREFIX)) {
    return {
      storageName: imageAttachmentStorageNameSchema.parse(
        value.slice(ATTACHMENT_REF_V1_PREFIX.length),
      ),
      transform: DEFAULT_IMAGE_TRANSFORM,
    }
  }
  if (!value.startsWith(ATTACHMENT_REF_V2_PREFIX)) return null
  const [storageName, detail, regionValue, ...extra] = value
    .slice(ATTACHMENT_REF_V2_PREFIX.length)
    .split(':')
  if (!storageName || !detail || !regionValue || extra.length > 0) {
    throw new Error('图片附件变换引用无效')
  }
  const region = regionValue === '-' ? undefined : parseRegion(regionValue)
  return {
    storageName: imageAttachmentStorageNameSchema.parse(storageName),
    transform: {
      detail: detail === 'original' ? 'original' : detail === 'high' ? 'high' : invalidDetail(),
      ...(region ? { region } : {}),
    },
  }
}

export function isImageAttachmentReference(value: string): boolean {
  return value.startsWith(ATTACHMENT_REF_V1_PREFIX)
    || value.startsWith(ATTACHMENT_REF_V2_PREFIX)
}

function parseRegion(value: string): NonNullable<ImageTransform['region']> {
  const numbers = value.split(',').map(Number)
  if (numbers.length !== 4 || numbers.some((number) => !Number.isSafeInteger(number))) {
    throw new Error('图片区域引用无效')
  }
  const [x, y, width, height] = numbers as [number, number, number, number]
  if (x < 0 || y < 0 || width <= 0 || height <= 0) throw new Error('图片区域引用无效')
  return { x, y, width, height }
}

function invalidDetail(): never {
  throw new Error('图片细节级别引用无效')
}
