import { browserReferenceSourceSchema, type BrowserRect } from '@whycode/core/browser-reference'
import type { BrowserReferenceImage, BrowserTargetCapture } from '../../shared/browser-reference.ts'

/** 每个编号保留自己捕获时的画面；滚动后的目标不能套用旧截图坐标。 */
export async function composeBrowserReference(captures: readonly BrowserTargetCapture[], comment: string): Promise<BrowserReferenceImage> {
  if (!captures.length) throw new Error('请先选择网页元素或区域')
  const images: ImageBitmap[] = []
  try {
    for (const capture of captures) images.push(await createImageBitmap(new Blob([new Uint8Array(capture.bytes)], { type: 'image/jpeg' })))
    const columns = captures.length === 1 ? 1 : 2
    const widths = Array.from({ length: columns }, (_, column) =>
      Math.min(columns === 1 ? 1200 : 780, Math.max(...images.filter((_, index) => index % columns === column).map(image => image.width))))
    const gap = 16, header = 32
    const heights = images.map((image, index) => Math.round(image.height * Math.min(1, widths[index % columns]! / image.width)))
    const rows = Array.from({ length: Math.ceil(images.length / columns) }, (_, row) =>
      Math.max(...heights.slice(row * columns, (row + 1) * columns)) + header)
    const canvas = document.createElement('canvas')
    canvas.width = widths.reduce((sum, width) => sum + width, 0) + (columns + 1) * gap
    canvas.height = rows.reduce((sum, height) => sum + height + gap, gap)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法生成引用截图')
    context.fillStyle = '#f4f6f9'; context.fillRect(0, 0, canvas.width, canvas.height)
    const targets = captures.map((capture, index) => {
      const image = images[index]!, row = Math.floor(index / columns)
      const column = index % columns, cell = widths[column]!
      const x = gap + widths.slice(0, column).reduce((sum, width) => sum + width + gap, 0)
      const y = gap + rows.slice(0, row).reduce((sum, height) => sum + height + gap, 0)
      const scale = Math.min(1, cell / image.width)
      const width = Math.round(image.width * scale), height = heights[index]!
      context.fillStyle = '#172439'; context.font = '600 16px sans-serif'
      context.fillText(`${index + 1}  ${capture.target.label}`, x + 4, y + 22, cell - 8)
      context.drawImage(image, x, y + header, width, height)
      const imageRect = { x, y: y + header, width, height }
      drawTargetMarker(context, capture, imageRect, index + 1)
      return { ...capture.target, crop: capture.crop, imageRect }
    })
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('无法生成引用截图')), 'image/jpeg', 0.9))
    return { bytes: new Uint8Array(await blob.arrayBuffer()), source: browserReferenceSourceSchema.parse({
      kind: 'browser-reference', id: crypto.randomUUID(), comment, page: captures[0]!.page, targets,
    }) }
  } finally { images.forEach(image => image.close()) }
}

function drawTargetMarker(context: CanvasRenderingContext2D, capture: BrowserTargetCapture, image: BrowserRect, number: number): void {
  const rect = capture.target.rect, crop = capture.crop
  const rx = Math.max(0, rect.x - crop.x), ry = Math.max(0, rect.y - crop.y)
  const rw = Math.min(crop.width, rect.x - crop.x + rect.width) - rx
  const rh = Math.min(crop.height, rect.y - crop.y + rect.height) - ry
  const left = image.x + rx / crop.width * image.width, top = image.y + ry / crop.height * image.height
  context.save()
  context.beginPath(); context.rect(image.x, image.y, image.width, image.height); context.clip()
  context.strokeStyle = '#1769ef'; context.lineWidth = 3
  context.strokeRect(left + 1.5, top + 1.5,
    Math.max(1, rw / crop.width * image.width - 3), Math.max(1, rh / crop.height * image.height - 3))
  const size = Math.min(28, image.width, image.height)
  const x = Math.min(left, image.x + image.width - size), y = Math.max(image.y, top - size)
  // 重编辑会从附件还原画面；不放大旧画面，实色底板覆盖同位置的旧编号。
  context.fillStyle = '#fff'; context.fillRect(x, y, size, size)
  context.fillStyle = '#1769ef'; context.beginPath()
  context.roundRect(x + 1, y + 1, size - 2, size - 2, Math.min(5, size / 4)); context.fill()
  context.fillStyle = '#fff'; context.font = `700 ${size * 0.6}px sans-serif`
  context.textAlign = 'center'; context.textBaseline = 'middle'
  context.fillText(String(number), x + size / 2, y + size / 2 + 0.5)
  context.restore()
}

/** 从现有附件还原各目标，不另存原图副本；未重新选取的目标保留原捕获事实。 */
export async function restoreBrowserReference(previewUrl: string, source: import('@whycode/core/browser-reference').BrowserReferenceSource): Promise<BrowserTargetCapture[]> {
  // 附件属于 img-src；沿用图片加载边界，不把预览地址当网络请求读取。
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = previewUrl
  try {
    await image.decode().catch(cause => { throw new Error('无法读取引用截图，请重新选择', { cause }) })
    return await Promise.all(source.targets.map(async ({ imageRect, crop, ...target }) => {
      if (imageRect.x < 0 || imageRect.y < 0 || imageRect.x + imageRect.width > image.width || imageRect.y + imageRect.height > image.height) {
        throw new Error('引用截图与目标范围不一致，请重新选择')
      }
      const canvas = document.createElement('canvas')
      canvas.width = imageRect.width; canvas.height = imageRect.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法读取引用截图')
      context.drawImage(image, imageRect.x, imageRect.y, imageRect.width, imageRect.height, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('无法读取引用截图')), 'image/jpeg', 0.95))
      return { target, crop, page: source.page, continuePicking: false, bytes: new Uint8Array(await blob.arrayBuffer()) }
    }))
  } finally { image.removeAttribute('src') }
}

export function sameBrowserTarget(a: BrowserTargetCapture, b: BrowserTargetCapture): boolean {
  if (a.page.url !== b.page.url || a.target.kind !== b.target.kind) return false
  if (a.target.selector && a.target.selector === b.target.selector) return true
  return ['x', 'y', 'width', 'height'].every(key => {
    const k = key as keyof typeof a.target.rect
    return Math.abs(a.target.rect[k] - b.target.rect[k]) < 2
  })
}
