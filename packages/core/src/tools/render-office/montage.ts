import sharp, { type OverlayOptions } from 'sharp'
import type { OfficeRenderedPage } from '../../office/types.ts'

const COLUMNS = 4
const GAP = 12
const LABEL_HEIGHT = 28
const MARGIN = 12
const TILE_HEIGHT = 220
const TILE_WIDTH = 320

export async function createOfficeOverview(
  pages: readonly OfficeRenderedPage[],
  outputPath: string,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (pages.length === 0) throw new Error('Office 总览没有可用页面')
  const columns = Math.min(COLUMNS, pages.length)
  const rows = Math.ceil(pages.length / columns)
  const width = MARGIN * 2 + columns * TILE_WIDTH + (columns - 1) * GAP
  const height = MARGIN * 2 + rows * (LABEL_HEIGHT + TILE_HEIGHT) + (rows - 1) * GAP
  const composites: OverlayOptions[] = []

  for (const [index, page] of pages.entries()) {
    abortSignal?.throwIfAborted()
    const column = index % columns
    const row = Math.floor(index / columns)
    const left = MARGIN + column * (TILE_WIDTH + GAP)
    const top = MARGIN + row * (LABEL_HEIGHT + TILE_HEIGHT + GAP)
    const thumbnail = await sharp(page.path)
      .rotate()
      .resize(TILE_WIDTH, TILE_HEIGHT, {
        background: '#FFFFFF',
        fit: 'contain',
      })
      .jpeg({ quality: 82 })
      .toBuffer()
    composites.push(
      { input: pageLabel(page.pageNumber), left, top },
      { input: thumbnail, left, top: top + LABEL_HEIGHT },
    )
  }

  abortSignal?.throwIfAborted()
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#F2F3F5',
    },
  })
    .composite(composites)
    .jpeg({ quality: 88 })
    .toFile(outputPath)
}

function pageLabel(pageNumber: number): Buffer {
  return Buffer.from(
    `<svg width="${TILE_WIDTH}" height="${LABEL_HEIGHT}">`
      + '<rect width="100%" height="100%" fill="#F2F3F5"/>'
      + `<text x="4" y="20" font-family="Arial, sans-serif" font-size="16" fill="#222222">Slide ${pageNumber}</text>`
      + '</svg>',
  )
}
