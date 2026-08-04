import { OfficeProcessingError } from '@whycode/core/office'

export const IMAGE_CONTENT_TYPES = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
} as const

export type ImageExtension = keyof typeof IMAGE_CONTENT_TYPES
export type SlideMediaRole = 'brand' | 'content' | 'decoration' | 'placeholder'

export interface SlideImage {
  bytes: Uint8Array
  extension: ImageExtension
}

interface SlideEditBase {
  shapeId: string
}

export type SlideTextEdit = SlideEditBase & (
  | { paragraphs: string[] }
  | { runs: string[] }
  | { text: string }
)

export type SlideImageEdit = SlideEditBase & {
  image: SlideImage
  mediaRole: SlideMediaRole
  reason: string
}

export type SlideDeleteEdit = SlideEditBase & {
  delete: true
  mediaRole?: SlideMediaRole
  reason: string
}

export type SlideKeepEdit = SlideEditBase & {
  keep: true
  mediaRole: 'brand' | 'decoration'
  reason: string
}

export type SlideEdit = SlideDeleteEdit | SlideImageEdit | SlideKeepEdit | SlideTextEdit

export interface SlidePlan {
  edits: SlideEdit[]
  sourceSlide: number
}

export interface PptxTemplatePlan {
  slides: SlidePlan[]
  template: Uint8Array
}

const MAX_SLIDES = 200
const MAX_EDITS = 2_000
const MAX_TEXT_CHARS = 2_000_000
const MAX_IMAGE_BYTES = 50_000_000
const MAX_TOTAL_IMAGE_BYTES = 100_000_000
const MEDIA_ROLES = new Set<SlideMediaRole>(['brand', 'content', 'decoration', 'placeholder'])
const EDIT_KEYS = new Set([
  'delete', 'image', 'keep', 'mediaRole', 'paragraphs', 'reason', 'runs', 'shapeId', 'text',
])

export function parsePptxTemplatePlan(value: unknown): PptxTemplatePlan {
  const input = record(value, 'OfficeTemplate.pptx 参数必须是对象')
  const template = bytes(input.template, 'OfficeTemplate.pptx.template 必须是模板 bytes')
  const slides = array(input.slides, 'slides').map((entry) => {
    const slide = record(entry, 'slides 项必须是对象')
    const sourceSlide = positiveInteger(slide.sourceSlide, 'sourceSlide')
    const edits = array(slide.edits ?? [], 'slides.edits').map(parseSlideEdit)
    requireUniqueShapeIds(edits)
    return { sourceSlide, edits }
  })
  if (slides.length === 0 || slides.length > MAX_SLIDES) {
    throw new OfficeProcessingError('too-large', `PPTX 模板输出页数必须在 1-${MAX_SLIDES} 之间`)
  }
  const edits = slides.flatMap((slide) => slide.edits)
  if (edits.length > MAX_EDITS) {
    throw new OfficeProcessingError('too-large', `PPTX 模板编辑最多 ${MAX_EDITS} 项`)
  }
  const totalChars = edits.flatMap(editStrings)
    .reduce((total, entry) => total + entry.length, 0)
  if (totalChars > MAX_TEXT_CHARS) {
    throw new OfficeProcessingError('too-large', 'PPTX 模板编辑文字超过 200 万字符')
  }
  const totalImageBytes = edits.reduce(
    (total, edit) => total + (hasImage(edit) ? edit.image.bytes.byteLength : 0),
    0,
  )
  if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
    throw new OfficeProcessingError('too-large', 'PPTX 模板替换图片总大小超过 100 MB')
  }
  return { template, slides }
}

export function hasImage(edit: SlideEdit): edit is SlideImageEdit {
  return 'image' in edit
}

export function isDelete(edit: SlideEdit): edit is SlideDeleteEdit {
  return 'delete' in edit
}

export function isKeep(edit: SlideEdit): edit is SlideKeepEdit {
  return 'keep' in edit
}

export function isTextEdit(edit: SlideEdit): edit is SlideTextEdit {
  return 'text' in edit || 'runs' in edit || 'paragraphs' in edit
}

function parseSlideEdit(value: unknown): SlideEdit {
  const input = record(value, 'slides.edits 项必须是对象')
  const unknownKey = Object.keys(input).find((key) => !EDIT_KEYS.has(key))
  if (unknownKey) {
    throw new OfficeProcessingError('corrupted', `PPTX 对象编辑包含未知字段：${unknownKey}`)
  }
  const shapeId = String(positiveInteger(input.shapeId, 'shapeId'))
  const kinds = [
    input.text !== undefined,
    input.runs !== undefined,
    input.paragraphs !== undefined,
    input.image !== undefined,
    input.delete !== undefined,
    input.keep !== undefined,
  ].filter(Boolean).length
  if (kinds !== 1) {
    throw new OfficeProcessingError(
      'corrupted',
      '每个 PPTX 对象编辑必须且只能提供 text、runs、paragraphs、image、delete 或 keep 之一',
    )
  }
  if (input.text !== undefined) return textEdit(input, { shapeId, text: text(input.text) })
  if (input.runs !== undefined) {
    return textEdit(input, { shapeId, runs: textArray(input.runs, 'runs') })
  }
  if (input.paragraphs !== undefined) {
    return textEdit(input, { shapeId, paragraphs: textArray(input.paragraphs, 'paragraphs') })
  }
  const reason = requiredReason(input.reason)
  if (input.image !== undefined) {
    return { shapeId, image: parseImage(input.image), mediaRole: mediaRole(input.mediaRole), reason }
  }
  if (input.delete !== undefined) {
    if (input.delete !== true) throw new OfficeProcessingError('corrupted', 'delete 必须为 true')
    return {
      shapeId,
      delete: true,
      ...(input.mediaRole === undefined ? {} : { mediaRole: mediaRole(input.mediaRole) }),
      reason,
    }
  }
  if (input.keep !== true) throw new OfficeProcessingError('corrupted', 'keep 必须为 true')
  const role = mediaRole(input.mediaRole)
  if (role !== 'brand' && role !== 'decoration') {
    throw new OfficeProcessingError('corrupted', 'keep 只适用于 brand 或 decoration 媒体')
  }
  return { shapeId, keep: true, mediaRole: role, reason }
}

function textEdit(input: Record<string, unknown>, edit: SlideTextEdit): SlideTextEdit {
  if (input.mediaRole !== undefined || input.reason !== undefined) {
    throw new OfficeProcessingError('corrupted', '文字编辑不接受 mediaRole 或 reason')
  }
  return edit
}

function parseImage(value: unknown): SlideImage {
  const input = record(value, 'image 必须是对象')
  const valueBytes = bytes(input.bytes, 'image.bytes 必须是图片 bytes')
  if (valueBytes.byteLength > MAX_IMAGE_BYTES) {
    throw new OfficeProcessingError('too-large', '单张 PPTX 模板替换图片超过 50 MB')
  }
  const extension = typeof input.extension === 'string'
    ? input.extension.toLowerCase().replace(/^\./u, '')
    : ''
  if (!Object.hasOwn(IMAGE_CONTENT_TYPES, extension)) {
    throw new OfficeProcessingError('unsupported', 'PPTX 模板图片只支持 PNG、JPEG、GIF 或 SVG')
  }
  return { bytes: valueBytes, extension: extension as ImageExtension }
}

function mediaRole(value: unknown): SlideMediaRole {
  if (typeof value !== 'string' || !MEDIA_ROLES.has(value as SlideMediaRole)) {
    throw new OfficeProcessingError(
      'corrupted',
      'mediaRole 必须是 brand、decoration、content 或 placeholder',
    )
  }
  return value as SlideMediaRole
}

function requiredReason(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\u0000')) {
    throw new OfficeProcessingError('corrupted', '媒体处置 reason 必须为 1-500 个字符')
  }
  const result = value.trim()
  if (!result || result.length > 500) {
    throw new OfficeProcessingError('corrupted', '媒体处置 reason 必须为 1-500 个字符')
  }
  return result
}

function requireUniqueShapeIds(edits: readonly SlideEdit[]): void {
  const ids = new Set<string>()
  for (const edit of edits) {
    if (ids.has(edit.shapeId)) {
      throw new OfficeProcessingError('corrupted', `同一输出页重复编辑 shape[${edit.shapeId}]`)
    }
    ids.add(edit.shapeId)
  }
}

function editStrings(edit: SlideEdit): string[] {
  if ('text' in edit) return [edit.text]
  if ('runs' in edit) return edit.runs
  if ('paragraphs' in edit) return edit.paragraphs
  return [edit.reason]
}

function textArray(value: unknown, name: string): string[] {
  const result = array(value, name).map(text)
  if (result.length === 0) throw new OfficeProcessingError('corrupted', `${name} 不能为空`)
  return result
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\u0000')) {
    throw new OfficeProcessingError('corrupted', 'PPTX 模板编辑文字无效')
  }
  return value
}

function positiveInteger(value: unknown, name: string): number {
  const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(number) || Number(number) < 1) {
    throw new OfficeProcessingError('corrupted', `${name} 必须是正整数`)
  }
  return Number(number)
}

function bytes(value: unknown, message: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new OfficeProcessingError('corrupted', message)
  }
  return value
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new OfficeProcessingError('corrupted', `${name} 必须是数组`)
  return value
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OfficeProcessingError('corrupted', message)
  }
  return value as Record<string, unknown>
}
