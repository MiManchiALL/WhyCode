import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, readFile, writeFile, rm, access, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import sharp from 'sharp'

const environment = resolve(process.argv[2] ?? '')
const root = await mkdtemp(join(tmpdir(), 'whycode-montage-test-'))
after(async () => {
  assert.ok(resolve(root).startsWith(resolve(tmpdir(), 'whycode-montage-test-')))
  await rm(root, { recursive: true, force: true })
})
const command = async (...args) => {
  const result = await promisify(execFile)(process.execPath, [join(environment, 'montage.mjs'), ...args], { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 })
  return JSON.parse(result.stdout)
}
const colors = Array.from({ length: 9 }, (_, i) => [30 + i * 20, 160 - i * 10, 50 + i * 15])
const sources = []
for (const [index, [r, g, b]] of colors.entries()) {
  const file = join(root, `第 ${index + 1} 页.png`)
  await sharp({ create: { width: 320, height: 180, channels: 3, background: { r, g, b } } }).png().toFile(file)
  sources.push(file)
}

async function pixels(path) {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.ok(info.width <= 2048 && info.height <= 2048)
  return { info, pixel: (x, y) => [...data.subarray((Math.floor(y) * info.width + Math.floor(x)) * 3, (Math.floor(y) * info.width + Math.floor(x)) * 3 + 3)] }
}

test('4/9-page CLI montages preserve input order, labels, colored content and bounded output', async () => {
  for (const [count, columns] of [[4, 2], [9, 3]]) {
    const ordered = sources.slice(0, count).reverse()
    const labels = ordered.map(file => `Source ${sources.indexOf(file) + 1} <&>`)
    const result = await command('--output', join(root, `grid-${count}.png`), '--columns', String(columns), ...labels.flatMap(label => ['--label', label]), ...ordered)
    assert.equal(result.rows, columns)
    assert.deepEqual(result.images.map(image => image.path), ordered)
    assert.deepEqual(result.images.map(image => image.label), labels)
    const { info, pixel } = await pixels(result.output)
    assert.equal(result.width, info.width)
    assert.equal(result.height, info.height)
    const cellWidth = (info.width - 12 * (columns + 1)) / columns
    const cellHeight = (info.height - 12 * (columns + 1)) / columns - 28
    for (let i = 0; i < count; i++) {
      const x = 12 + (i % columns) * (cellWidth + 12)
      const y = 12 + Math.floor(i / columns) * (cellHeight + 40)
      assert.deepEqual(pixel(x + cellWidth / 2, y + cellHeight / 2), colors[count - i - 1])
      let ink = 0
      for (let cy = y + cellHeight; cy < y + cellHeight + 28; cy++) {
        for (let cx = x; cx < x + cellWidth; cx++) if (pixel(cx, cy).every(channel => channel < 150)) ink++
      }
      assert.ok(ink > 50, 'source label is rendered, not only reported in JSON')
    }
  }
})

test('five images use a partial row; portrait, EXIF orientation, WebP and transparency remain intact', async () => {
  const portrait = join(root, 'portrait.jpg')
  await sharp({ create: { width: 320, height: 180, channels: 3, background: '#cc2211' } }).withMetadata({ orientation: 6 }).jpeg().toFile(portrait)
  const transparent = join(root, 'transparent.webp')
  await sharp({ create: { width: 120, height: 120, channels: 4, background: '#00000000' } }).webp().toFile(transparent)
  const result = await command('--output', join(root, 'mixed.png'), '--columns', '2', portrait, sources[0], transparent, ...sources.slice(1, 3))
  assert.equal(result.rows, 3)
  assert.equal(result.images[0].label, 'portrait.jpg')
  const { info, pixel } = await pixels(result.output)
  const cellWidth = (info.width - 36) / 2
  const cellHeight = (info.height - 48) / 3 - 28
  assert.ok(cellHeight > cellWidth, 'first input is auto-oriented before choosing cell geometry')
  assert.deepEqual(pixel(12 + cellWidth / 2, 12 + cellHeight + 40 + cellHeight / 2), [255, 255, 255])
  assert.deepEqual(pixel(24 + cellWidth * 1.5, 12 + 2 * (cellHeight + 40) + cellHeight / 2), [242, 243, 245])
  assert.deepEqual(pixel(24 + cellWidth * 1.5, 14), [255, 255, 255], 'landscape image fits inside the portrait cell without cropping')
})

test('extreme aspect ratios and a 36-image group stay within the canvas limit', async () => {
  for (const [width, height] of [[1, 8192], [8192, 1]]) {
    const source = join(root, `edge-${width}.png`)
    await sharp({ create: { width, height, channels: 3, background: 'black' } }).png().toFile(source)
    const result = await command('--output', join(root, `edge-grid-${width}.png`), '--columns', '1', ...Array(36).fill(source))
    await pixels(result.output)
  }
  await assert.rejects(command('--output', join(root, 'too-many.png'), ...Array(37).fill(sources[0])), /1–36/)
})

test('invalid input/options fail without output; an existing source/output is never overwritten', async () => {
  const output = join(root, 'invalid.png')
  await assert.rejects(command('--output', output, '--columns', '0', sources[0]), /columns/)
  await assert.rejects(command('--output', output, '--label', 'only one', ...sources.slice(0, 2)), /label/)
  const invalid = join(root, 'not-image.png')
  await writeFile(invalid, 'invalid image')
  await assert.rejects(command('--output', output, sources[0], invalid), /Image 2/)
  await assert.rejects(access(output), { code: 'ENOENT' })
  const before = await readFile(sources[0])
  await assert.rejects(command('--output', sources[0], sources[0]), /EEXIST/)
  assert.deepEqual(await readFile(sources[0]), before)
})

test('byte and pixel limits reject oversized source files before composition', async () => {
  const large = join(root, 'large.png')
  const handle = await open(large, 'wx')
  try { await handle.truncate(20 * 1024 * 1024 + 1) } finally { await handle.close() }
  const output = join(root, 'too-large.png')
  await assert.rejects(command('--output', output, large), /bytes/)
  await sharp({ create: { width: 5000, height: 5000, channels: 3, background: 'white' } }).png().toFile(large)
  await assert.rejects(command('--output', output, large), /pixel limit/)
  await assert.rejects(access(output), { code: 'ENOENT' })
})
