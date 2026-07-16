import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import { withPdfAttachmentReferences } from './messages.ts'
import { inlineSmallPdfMessages } from './inline-messages.ts'
import type { PdfProcessor } from './processor.ts'
import type { PdfAttachment } from './types.ts'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('小 PDF 请求期双通道展开', () => {
  it('在上传消息中附加逐页文字和页面图，持久消息不含 Base64，并复用校验缓存', async () => {
    const root = await tempRoot()
    const attachment = pdfAttachment('22222222-2222-4222-8222-222222222222', 'paper.pdf', 2)
    await writeFile(join(root, attachment.storageName), '%PDF-test')
    let reads = 0
    const processor = renderingProcessor(() => { reads++ })
    const original: ModelMessage[] = [{
      role: 'user',
      content: withPdfAttachmentReferences('请阅读论文', [attachment]),
    }]

    const first = await inlineSmallPdfMessages(
      original, [attachment], root, processor, new AbortController().signal,
    )
    const second = await inlineSmallPdfMessages(
      original, [attachment], root, processor, new AbortController().signal,
    )

    assert.equal(reads, 1)
    assert.equal(imageParts(first).length, 2)
    assert.equal(imageParts(second).length, 2)
    assert.match(JSON.stringify(first), /第 1 页正文/)
    assert.match(JSON.stringify(first), /文字 \+ 对应页面图/)
    assert.doesNotMatch(JSON.stringify(original), /iVBORw0/)
  })

  it('只自动展开最近引用且受总页数预算约束的小 PDF', async () => {
    const root = await tempRoot()
    const older = pdfAttachment('22222222-2222-4222-8222-222222222222', 'older.pdf', 3)
    const newer = pdfAttachment('33333333-3333-4333-8333-333333333333', 'newer.pdf', 3)
    await Promise.all([
      writeFile(join(root, older.storageName), '%PDF-old'),
      writeFile(join(root, newer.storageName), '%PDF-new'),
    ])
    let reads = 0
    const messages: ModelMessage[] = [
      { role: 'user', content: withPdfAttachmentReferences('旧文档', [older]) },
      { role: 'assistant', content: '收到' },
      { role: 'user', content: withPdfAttachmentReferences('新文档', [newer]) },
    ]
    const result = await inlineSmallPdfMessages(
      messages,
      [older, newer],
      root,
      renderingProcessor(() => { reads++ }),
      new AbortController().signal,
    )
    assert.equal(reads, 1)
    assert.equal(imageParts(result).length, 3)
    assert.equal(typeof result[0]?.content, 'string')
    assert.match(JSON.stringify(result[2]), /newer\.pdf.*whycode-pdf-inline/s)
  })

  it('同一消息的多份 PDF 保持用户附件顺序', async () => {
    const root = await tempRoot()
    const first = pdfAttachment('66666666-6666-4666-8666-666666666666', 'first.pdf', 1)
    const second = pdfAttachment('77777777-7777-4777-8777-777777777777', 'second.pdf', 1)
    await Promise.all([
      writeFile(join(root, first.storageName), '%PDF-first'),
      writeFile(join(root, second.storageName), '%PDF-second'),
    ])
    const messages: ModelMessage[] = [{
      role: 'user',
      content: withPdfAttachmentReferences('按顺序阅读', [first, second]),
    }]
    const result = await inlineSmallPdfMessages(
      messages,
      [first, second],
      root,
      renderingProcessor(() => {}),
      new AbortController().signal,
    )
    const serialized = JSON.stringify(result)
    const firstInline = serialized.indexOf(
      `whycode-pdf-inline attachment-id=\\"${first.id}\\"`,
    )
    const secondInline = serialized.indexOf(
      `whycode-pdf-inline attachment-id=\\"${second.id}\\"`,
    )
    assert.ok(firstInline >= 0 && secondInline > firstInline)
  })

  it('大 PDF 只保留稳定引用，等待模型按页调用 ReadPdf', async () => {
    const root = await tempRoot()
    const attachment = pdfAttachment('44444444-4444-4444-8444-444444444444', 'large.pdf', 5)
    const messages: ModelMessage[] = [{
      role: 'user',
      content: withPdfAttachmentReferences('阅读大文档', [attachment]),
    }]
    const result = await inlineSmallPdfMessages(
      messages,
      [attachment],
      root,
      renderingProcessor(() => assert.fail('大 PDF 不应自动渲染')),
      new AbortController().signal,
    )
    assert.deepEqual(result, messages)
  })

  it('文字异常密集的小 PDF 仍会自动展开，并明确标记截断', async () => {
    const root = await tempRoot()
    const attachment = pdfAttachment('55555555-5555-4555-8555-555555555555', 'dense.pdf', 1)
    await writeFile(join(root, attachment.storageName), '%PDF-dense')
    const messages: ModelMessage[] = [{
      role: 'user',
      content: withPdfAttachmentReferences('阅读密集文档', [attachment]),
    }]
    const result = await inlineSmallPdfMessages(
      messages,
      [attachment],
      root,
      renderingProcessor(() => {}, () => 'x'.repeat(70_000)),
      new AbortController().signal,
    )
    assert.equal(imageParts(result).length, 1)
    assert.match(JSON.stringify(result), /本页文字已按自动展开上限截断/)
  })
})

function renderingProcessor(onRead: () => void, textForPage?: (page: number) => string): PdfProcessor {
  return {
    async inspect() {
      return { pageCount: 1, byteLength: 1 }
    },
    async readPages(_path, options) {
      onRead()
      await mkdir(options.outputDirectory!, { recursive: true })
      const pages = []
      const renderedPages = []
      for (let page = 1; page <= options.pageCount; page++) {
        const path = join(options.outputDirectory!, `page-${String(page).padStart(4, '0')}.png`)
        await writeFile(path, ONE_PIXEL_PNG)
        pages.push({ pageNumber: page, text: textForPage?.(page) ?? `第 ${page} 页正文` })
        renderedPages.push({ pageNumber: page, path, width: 1, height: 1 })
      }
      return { pageCount: options.pageCount, pages, renderedPages }
    },
  }
}

function pdfAttachment(id: string, name: string, pageCount: number): PdfAttachment {
  return {
    id,
    sessionId: SESSION_ID,
    name,
    storageName: `${id}.pdf`,
    mediaType: 'application/pdf',
    sha256: id.replaceAll('-', '').repeat(2).slice(0, 64),
    byteLength: 123,
    pageCount,
  }
}

function imageParts(messages: readonly ModelMessage[]) {
  return messages.flatMap((message) =>
    message.role === 'user' && typeof message.content !== 'string'
      ? message.content.filter((part) => part.type === 'file' && part.mediaType === 'image/png')
      : [])
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-inline-pdf-'))
  roots.push(root)
  return root
}
