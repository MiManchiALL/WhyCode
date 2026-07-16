import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, before, describe, it } from 'node:test'
import { inspectPdf, readPdfPages } from './engine.ts'

const tempDirectories: string[] = []

before(async () => {
  const canvas = await import('@napi-rs/canvas')
  Object.assign(globalThis, {
    DOMMatrix: canvas.DOMMatrix,
    ImageData: canvas.ImageData,
    Path2D: canvas.Path2D,
  })
})

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })))
})

describe('桌面 PDF 引擎', () => {
  it('解析页数与文字，并把页面渲染为真实 PNG', async () => {
    const root = await tempDirectory()
    const pdfPath = join(root, 'hello.pdf')
    const outputDirectory = join(root, 'rendered')
    const bytes = minimalPdf('Hello WhyCode PDF')
    await writeFile(pdfPath, bytes)

    assert.deepEqual(await inspectPdf(pdfPath), {
      pageCount: 1,
      byteLength: bytes.byteLength,
    })
    const result = await readPdfPages(pdfPath, {
      startPage: 1,
      pageCount: 1,
      render: true,
      outputDirectory,
    })
    assert.match(result.pages[0]?.text ?? '', /Hello WhyCode PDF/)
    assert.equal(result.renderedPages.length, 1)
    assert.ok((result.renderedPages[0]?.width ?? 0) > 1_000)
    const png = await readFile(result.renderedPages[0]!.path)
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    assert.ok(png.byteLength > 1_000)
  })

  it('拒绝伪装文件和越界页码', async () => {
    const root = await tempDirectory()
    const fakePath = join(root, 'fake.pdf')
    await writeFile(fakePath, 'not a pdf')
    await assert.rejects(inspectPdf(fakePath), /缺少有效 PDF 文件头/)

    const validPath = join(root, 'valid.pdf')
    await writeFile(validPath, minimalPdf('one page'))
    await assert.rejects(
      readPdfPages(validPath, { startPage: 2, pageCount: 1, render: false }),
      /起始页 2 超出 PDF 总页数 1/,
    )
    await assert.rejects(
      readPdfPages(validPath, {
        startPage: 1,
        pageCount: 1,
        render: false,
        expectedSha256: 'a'.repeat(64),
      }),
      /PDF 附件内容已发生变化/,
    )
  })
})

function minimalPdf(text: string): Buffer {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let content = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content))
    content += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xrefOffset = Buffer.byteLength(content)
  content += `xref\n0 ${objects.length + 1}\n`
  content += '0000000000 65535 f \n'
  for (const offset of offsets.slice(1)) {
    content += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  content += `startxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(content, 'ascii')
}

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'whycode-pdf-engine-'))
  tempDirectories.push(path)
  return path
}
