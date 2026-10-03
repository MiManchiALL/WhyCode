import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Document, Packer, Paragraph } from 'docx'
import pptxgen from 'pptxgenjs'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import sharp from 'sharp'

const environment = resolve(process.argv[2] ?? '')
const { checkOffice } = await import(pathToFileURL(join(environment, 'check.mjs')).href)
const root = await mkdtemp(join(tmpdir(), 'whycode-office-test-'))
after(async () => {
  assert.ok(root.startsWith(join(tmpdir(), 'whycode-office-test-')))
  await rm(root, { recursive: true, force: true })
})
const command = async (...args) => {
  const result = await promisify(execFile)(process.execPath, [join(environment, 'office.mjs'), ...args], { windowsHide: true, timeout: 150000, maxBuffer: 1024 * 1024 })
  return JSON.parse(result.stdout)
}
const docxPath = join(root, '文档.docx')
const deckPath = join(root, 'slides.pptx')
const bookPath = join(root, 'book.xlsx')
await writeFile(docxPath, await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('季度报告'), new Paragraph('Revenue 36'), new Paragraph('R&D < 10')] }] })))
const deck = new pptxgen()
deck.layout = 'LAYOUT_WIDE'
deck.addSlide().addText('First slide', { x: 1, y: 1, w: 8, h: 1, fontSize: 28 })
deck.addSlide().addText('Second slide', { x: 1, y: 1, w: 8, h: 1, fontSize: 28 })
await deck.writeFile({ fileName: deckPath })
const book = new ExcelJS.Workbook()
const sheet = book.addWorksheet('Summary')
sheet.addRow(['Quantity', 'Price', 'Total'])
sheet.addRow([3, 12, { formula: 'A2*B2' }])
sheet.getColumn(3).width = 18
await book.xlsx.writeFile(bookPath)

test('ordinary scripts generate and inspect editable DOCX/PPTX/XLSX with ordered relationships', async () => {
  assert.equal((await checkOffice(docxPath, { contains: ['季度报告', 'Revenue 36', 'R&D < 10'] })).ok, true)
  const slides = await checkOffice(deckPath, { count: 2, contains: ['First slide', 'Second slide'] })
  assert.equal(slides.ok, true)
  assert.match(slides.units[0].text, /First slide/)
  assert.match(slides.units[1].text, /Second slide/)
  const workbook = await checkOffice(bookPath, { sheet: 'Summary', requireCalculated: true })
  assert.equal(workbook.formulaCount, 1)
  assert.equal(workbook.missingFormulaResults, 1)
  assert.equal(workbook.ok, false)
})
test('checker rejects broken relationships, unsafe XML and missing required content', async () => {
  const zip = await JSZip.loadAsync(await readFile(deckPath))
  zip.remove('ppt/slides/slide1.xml')
  const broken = join(root, 'broken.pptx')
  await writeFile(broken, await zip.generateAsync({ type: 'nodebuffer' }))
  await assert.rejects(checkOffice(broken), /Missing relationship target/)
  const unsafe = await JSZip.loadAsync(await readFile(docxPath))
  unsafe.file('word/document.xml', '<!DOCTYPE document [<!ENTITY x "test">]><document/>')
  const path = join(root, 'unsafe.docx')
  await writeFile(path, await unsafe.generateAsync({ type: 'nodebuffer' }))
  await assert.rejects(checkOffice(path), /Invalid XML/)
  assert.equal((await checkOffice(docxPath, { contains: ['not present'] })).ok, false)
})
test('large sheet previews remain bounded and pagination advances', async () => {
  const large = new ExcelJS.Workbook()
  const data = large.addWorksheet('Long')
  for (let i = 0; i < 210; i++) data.addRow(['文'.repeat(2000)])
  const file = join(root, 'long.xlsx')
  await large.xlsx.writeFile(file)
  const report = await checkOffice(file)
  assert.equal(report.units.length, 1)
  assert.equal(report.units[0].cellsTruncated, true)
  assert.equal(report.nextOffset, null)
  assert.ok(JSON.stringify(report).length < 60000)
})
test('LibreOffice produces PNGs and PDF without changing input packages', async () => {
  const previews = []
  for (const [input, extra] of [[docxPath, ['--pages', '1']], [deckPath, ['--pages', '2']], [bookPath, ['--sheet', 'Summary', '--range', 'A1:C3']]]) {
    const before = await readFile(input)
    const output = join(root, 'preview-' + input.split('.').at(-1))
    await command('render', '--input', input, '--output-dir', output, '--dpi', '72', ...extra)
    const image = (await readdir(output, { recursive: true })).find(name => name.endsWith('.png'))
    assert.ok(image)
    previews.push(join(output, image))
    assert.deepEqual(await readFile(input), before)
  }
  const montage = join(root, 'overview.png')
  await promisify(execFile)(process.execPath, [join(environment, 'montage.mjs'), '--output', montage, '--columns', '2', ...previews], { windowsHide: true, timeout: 60000 })
  const overview = await sharp(montage).metadata()
  assert.equal(overview.format, 'png')
  assert.ok(overview.width <= 2048 && overview.height <= 2048)
  const pdf = join(root, 'report.pdf')
  await command('convert', '--input', docxPath, '--output', pdf)
  assert.equal((await readFile(pdf)).subarray(0, 5).toString(), '%PDF-')
})
test('LibreOffice recalculates formulas and checker verifies the final cached value', async () => {
  const final = join(root, 'final.xlsx')
  await command('recalculate', '--input', bookPath, '--output', final)
  const report = await checkOffice(final, { requireCalculated: true })
  assert.equal(report.ok, true, JSON.stringify(report))
  assert.equal(report.formulaCount, 1)
  assert.equal(report.units[0].cells.find(cell => cell.cell === 'C2').value, '36')
  assert.equal((await checkOffice(bookPath)).missingFormulaResults, 1)
})
test('CLI rejects invalid ranges/options and leaves an existing output directory intact', async () => {
  const output = join(root, 'existing')
  await mkdir(output)
  await writeFile(join(output, 'keep.txt'), 'keep')
  await assert.rejects(command('render', '--input', docxPath, '--output-dir', output))
  assert.equal(await readFile(join(output, 'keep.txt'), 'utf8'), 'keep')
  await assert.rejects(command('render', '--input', docxPath, '--output-dir', join(root, 'invalid'), '--pages', '0'))
})
