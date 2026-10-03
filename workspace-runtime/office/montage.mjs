import { open, rm } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import sharp from 'sharp'

const MAX_IMAGES = 36
const MAX_BYTES = 20 * 1024 * 1024
const MAX_PIXELS = 20_000_000
const EDGE = 2048
const GAP = 12
const CAPTION = 28

// 命令在独立进程内执行；只保留缩略图，不缓存各页解码后的原图。
sharp.cache(false)

async function readImage(path) {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size < 1 || info.size > MAX_BYTES) throw new Error(`Expected an image file of 1–${MAX_BYTES} bytes: ${path}`)
    const data = Buffer.alloc(info.size)
    let offset = 0
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
      if (!bytesRead) throw new Error(`Image changed while reading: ${path}`)
      offset += bytesRead
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) throw new Error(`Image changed while reading: ${path}`)
    return data
  } finally { await handle.close() }
}

function grid(metadata, count, columns) {
  const rows = Math.ceil(count / columns)
  const rotated = metadata.orientation >= 5 && metadata.orientation <= 8
  const ratio = rotated ? metadata.height / metadata.width : metadata.width / metadata.height
  const availableWidth = (EDGE - GAP * (columns + 1)) / columns
  const availableHeight = (EDGE - GAP * (rows + 1)) / rows - CAPTION
  const cellWidth = Math.max(1, Math.floor(Math.min(640, availableWidth, availableHeight * ratio)))
  const cellHeight = Math.max(1, Math.floor(Math.min(availableHeight, cellWidth / ratio)))
  return { columns, rows, cellWidth, cellHeight,
    width: columns * cellWidth + (columns + 1) * GAP,
    height: rows * (cellHeight + CAPTION) + (rows + 1) * GAP }
}

function caption(index, label, width) {
  const text = `${index}. ${label}`.replace(/[\u0000-\u001f\u007f]/g, ' ')
  const escape = value => value.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char])
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${CAPTION}"><text x="6" y="19" font-family="sans-serif" font-size="16" fill="#252525">${escape(text)}</text></svg>`)
}

async function savePng(output, data) {
  const handle = await open(output, 'wx')
  try { await handle.writeFile(data) }
  catch (error) { await handle.close(); await rm(output, { force: true }); throw error }
  finally { await handle.close() }
}

export async function createMontage(inputs, { output, columns = Math.ceil(Math.sqrt(inputs.length)), labels } = {}) {
  if (inputs.length < 1 || inputs.length > MAX_IMAGES) throw new Error(`Provide 1–${MAX_IMAGES} images in the desired order`)
  if (!output || !output.toLowerCase().endsWith('.png')) throw new Error('--output must name a new PNG file')
  if (!Number.isInteger(columns) || columns < 1 || columns > inputs.length) throw new Error('--columns must be an integer between 1 and the image count')
  if (labels && (labels.length !== inputs.length || labels.some(label => !label.trim() || label.length > 160))) throw new Error('Provide one nonempty --label per image, at most 160 characters each')
  const images = inputs.map((input, index) => ({ index: index + 1, path: resolve(input), label: labels?.[index] ?? basename(input) }))
  const tiles = []
  let layout
  for (const source of images) {
    try {
      const image = sharp(await readImage(source.path), { limitInputPixels: MAX_PIXELS, failOn: 'warning' })
      const metadata = await image.metadata()
      if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages ?? 1) !== 1) throw new Error('Only single-frame PNG, JPEG and WebP images are supported')
      if (!metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192) throw new Error('Image dimensions must be within 8192 × 8192')
      layout ??= grid(metadata, inputs.length, columns)
      const left = GAP + ((source.index - 1) % columns) * (layout.cellWidth + GAP)
      const top = GAP + Math.floor((source.index - 1) / columns) * (layout.cellHeight + CAPTION + GAP)
      const input = await image.autoOrient().resize(layout.cellWidth, layout.cellHeight, { fit: 'contain', background: 'white' })
        .flatten({ background: 'white' }).png().timeout({ seconds: 15 }).toBuffer()
      tiles.push({ input, left, top }, { input: caption(source.index, source.label, layout.cellWidth), left, top: top + layout.cellHeight })
    } catch (error) { throw new Error(`Image ${source.index} (${source.path}): ${error.message}`, { cause: error }) }
  }
  const data = await sharp({ create: { width: layout.width, height: layout.height, channels: 3, background: '#f2f3f5' } })
    .composite(tiles).png().timeout({ seconds: 15 }).toBuffer()
  await savePng(resolve(output), data)
  return { output: resolve(output), width: layout.width, height: layout.height, columns, rows: layout.rows, images }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: {
      output: { type: 'string' }, columns: { type: 'string' }, label: { type: 'string', multiple: true },
    } })
    console.log(JSON.stringify(await createMontage(positionals, { output: values.output,
      ...(values.columns === undefined ? {} : { columns: Number(values.columns) }), labels: values.label })))
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, code: error.code ?? 'failed' }))
    process.exitCode = 1
  }
}
