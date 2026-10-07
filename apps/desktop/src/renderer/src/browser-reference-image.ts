import { browserReferenceSourceSchema } from '@whycode/core/browser-reference'
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
      const rect = capture.target.rect, crop = capture.crop
      const rx = Math.max(0, rect.x - crop.x), ry = Math.max(0, rect.y - crop.y)
      const rw = Math.min(crop.width, rect.x - crop.x + rect.width) - rx
      const rh = Math.min(crop.height, rect.y - crop.y + rect.height) - ry
      context.strokeStyle = '#1769ef'; context.lineWidth = 3
      context.strokeRect(x + rx / crop.width * width + 1.5, y + header + ry / crop.height * height + 1.5,
        Math.max(1, rw / crop.width * width - 3), Math.max(1, rh / crop.height * height - 3))
      return { ...capture.target, imageRect: { x, y: y + header, width, height } }
    })
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('无法生成引用截图')), 'image/jpeg', 0.9))
    return { bytes: new Uint8Array(await blob.arrayBuffer()), source: browserReferenceSourceSchema.parse({
      kind: 'browser-reference', id: crypto.randomUUID(), comment, page: captures[0]!.page, targets,
    }) }
  } finally { images.forEach(image => image.close()) }
}

export function sameBrowserTarget(a: BrowserTargetCapture, b: BrowserTargetCapture): boolean {
  if (a.page.url !== b.page.url || a.target.kind !== b.target.kind) return false
  if (a.target.selector && a.target.selector === b.target.selector) return true
  return ['x', 'y', 'width', 'height'].every(key => {
    const k = key as keyof typeof a.target.rect
    return Math.abs(a.target.rect[k] - b.target.rect[k]) < 2
  })
}
