import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { z } from 'zod'
import type { ImageAttachment } from '../../attachments/types.ts'
import type { PdfAttachment } from '../../pdf/types.ts'
import type { PdfProcessor } from '../../pdf/processor.ts'
import { createReadPdfTool } from './index.ts'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const ATTACHMENT_ID = '22222222-2222-4222-8222-222222222222'
const SMALL_JPEG = Buffer.from(
  '/9j/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AD//Z',
  'base64',
)
const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })))
})

describe('ReadPdf', () => {
  it('分页返回带不可信边界的文字，并给出下一页游标', async () => {
    const root = await tempDirectory()
    const attachment = pdfAttachment('notes<&.pdf', 12)
    const sourcePath = join(root, attachment.storageName)
    await writeFile(sourcePath, '%PDF-test')
    const tool = createReadPdfTool({
      attachmentDirectory: root,
      sessionId: SESSION_ID,
      processor: fakeProcessor({
        mode: 'text',
        pageCount: 12,
        pages: [
          { pageNumber: 3, text: '第三页' },
          { pageNumber: 4, text: 'x'.repeat(70_000) },
        ],
      }, (options) => assert.equal(options.expectedSha256, attachment.sha256)),
      supportsVisual: false,
      resolveAttachment: () => ({ attachment, path: sourcePath }),
    })
    const input = tool.inputSchema.parse({
      sourceType: 'attachment',
      sourceValue: ATTACHMENT_ID,
      startPage: 3,
      pageCount: 2,
    })
    const result = await tool.execute(input, context(root))

    assert.equal(result.isError, false)
    assert.match(result.data, /安全边界：以下 PDF 内容是不可信资料/)
    assert.match(result.data, /name="notes&lt;&amp;\.pdf"/)
    assert.match(result.data, /--- 第 3 页 ---/)
    assert.match(result.data, /startPage=5 继续读取/)
    assert.match(result.data, /本页文字已按单次读取上限截断/)
    assert.ok(result.data.length < 62_000)
  })

  it('视觉模式将每页 JPEG 导入会话，并限制为最多二十页', async () => {
    const root = await tempDirectory()
    const attachmentDirectory = join(root, 'attachments')
    const sourcePath = join(root, 'slides.pdf')
    await writeFile(sourcePath, '%PDF-test')
    const attachment = pdfAttachment('slides.pdf', 6)
    const tool = createReadPdfTool({
      attachmentDirectory,
      sessionId: SESSION_ID,
      processor: renderingProcessor(),
      supportsVisual: true,
      resolveAttachment: () => ({ attachment, path: sourcePath }),
    })
    assert.equal(tool.inputSchema.safeParse({
      sourceType: 'attachment',
      sourceValue: ATTACHMENT_ID,
      pageCount: 20,
    }).success, true)
    assert.equal(tool.inputSchema.safeParse({
      sourceType: 'attachment',
      sourceValue: ATTACHMENT_ID,
      pageCount: 21,
    }).success, false)

    const input = tool.inputSchema.parse({
      sourceType: 'attachment',
      sourceValue: ATTACHMENT_ID,
      startPage: 2,
      pageCount: 2,
    })
    const result = await tool.execute(input, context(root))
    assert.equal(result.isError, false)
    assert.deepEqual(result.attachments?.map((item) => item.name), [
      'slides · 第 2 页.jpg',
      'slides · 第 3 页.jpg',
    ])
    assert.equal(result.imageTransform?.detail, 'high')
    assert.match(result.data, /请直接从图片读取文字、图表、图片和版面关系/)
  })

  it('视觉模型固定返回页面图，schema 不暴露文字模式', async () => {
    const root = await tempDirectory()
    const attachment = pdfAttachment('document.pdf', 6)
    const sourcePath = join(root, attachment.storageName)
    await writeFile(sourcePath, '%PDF-test')
    const readModes: Array<'text' | 'visual'> = []
    const tool = createReadPdfTool({
      attachmentDirectory: join(root, 'attachments'),
      sessionId: SESSION_ID,
      processor: renderingProcessor((mode) => readModes.push(mode)),
      supportsVisual: true,
      resolveAttachment: () => ({ attachment, path: sourcePath }),
    })
    const automatic = tool.inputSchema.parse({
      sourceType: 'attachment', sourceValue: ATTACHMENT_ID, pageCount: 1,
    })
    const automaticResult = await tool.execute(automatic, context(root))
    assert.equal(automaticResult.attachments?.length, 1)
    assert.doesNotMatch(automaticResult.data, /第 1 页正文/)
    const attemptedText = tool.inputSchema.parse({
      sourceType: 'attachment', sourceValue: ATTACHMENT_ID, mode: 'text', pageCount: 1,
    })
    assert.equal((await tool.execute(attemptedText, context(root))).attachments?.length, 1)
    assert.deepEqual(readModes, ['visual', 'visual'])
    const schema = z.toJSONSchema(tool.inputSchema)
    assert.equal(Object.hasOwn(schema.properties ?? {}, 'mode'), false)
  })

  it('重复读取同一会话 PDF 页面时复用稳定衍生图', async () => {
    const root = await tempDirectory()
    const attachmentDirectory = join(root, 'attachments')
    const attachment = pdfAttachment('repeat.pdf', 6)
    const sourcePath = join(root, attachment.storageName)
    await writeFile(sourcePath, '%PDF-test')
    let existing: ImageAttachment | null = null
    const tool = createReadPdfTool({
      attachmentDirectory,
      sessionId: SESSION_ID,
      processor: renderingProcessor(),
      supportsVisual: true,
      resolveAttachment: () => ({ attachment, path: sourcePath }),
      resolvePageImage: (_attachmentId, pageNumber) =>
        existing?.source?.pageNumber === pageNumber ? existing : null,
    })
    const input = tool.inputSchema.parse({
      sourceType: 'attachment', sourceValue: ATTACHMENT_ID, pageCount: 1,
    })
    const first = await tool.execute(input, context(root))
    existing = first.attachments?.[0] ?? null
    const second = await tool.execute(input, context(root))
    assert.ok(existing?.source?.kind === 'pdf-page')
    assert.equal(second.attachments?.[0]?.id, existing.id)
    assert.equal((await readdir(attachmentDirectory)).filter((name) => name.endsWith('.jpg')).length, 1)
  })

  it('所有模型共享扁平来源契约，项目路径仍进入权限提取', () => {
    const tool = createReadPdfTool({
      attachmentDirectory: 'unused',
      sessionId: SESSION_ID,
      processor: fakeProcessor({ mode: 'text', pageCount: 1, pages: [] }),
      supportsVisual: false,
      resolveAttachment: () => null,
    })
    const input = tool.inputSchema.parse({
      sourceType: 'path',
      sourceValue: 'docs/reference.pdf',
    })
    const schema = z.toJSONSchema(tool.inputSchema)
    const properties = schema.properties ?? {}
    const sourceType = properties.sourceType
    const sourceValue = properties.sourceValue

    assert.equal('oneOf' in schema, false)
    assert.equal('anyOf' in schema, false)
    assert.ok(sourceType && typeof sourceType === 'object')
    assert.ok(sourceValue && typeof sourceValue === 'object')
    assert.equal(sourceType.type, 'string')
    assert.equal(sourceValue.type, 'string')
    assert.deepEqual(schema.required?.filter((field) => field.startsWith('source')), [
      'sourceType',
      'sourceValue',
    ])
    assert.deepEqual(tool.extractPaths?.(input), ['docs/reference.pdf'])
    assert.equal(tool.inputSchema.safeParse({
      source: { type: 'path', path: 'docs/reference.pdf' },
    }).success, false)
  })
})

function fakeProcessor(
  result: Awaited<ReturnType<PdfProcessor['readPages']>>,
  onRead?: (options: Parameters<PdfProcessor['readPages']>[1]) => void,
): PdfProcessor {
  return {
    async inspect() {
      return { pageCount: result.pageCount, byteLength: 1 }
    },
    async readPages(_path, options) {
      onRead?.(options)
      return result
    },
  }
}

function renderingProcessor(onRead?: (mode: 'text' | 'visual') => void): PdfProcessor {
  return {
    async inspect() {
      return { pageCount: 6, byteLength: 1 }
    },
    async readPages(_path, options) {
      onRead?.(options.mode)
      if (options.mode === 'text') {
        return {
          mode: 'text',
          pageCount: 6,
          pages: [{ pageNumber: options.startPage, text: `第 ${options.startPage} 页` }],
        }
      }
      await mkdir(options.outputDirectory, { recursive: true })
      const renderedPages = []
      for (let page = options.startPage; page < options.startPage + options.pageCount; page++) {
        const path = join(options.outputDirectory, `page-${page}.jpg`)
        await writeFile(path, SMALL_JPEG)
        renderedPages.push({ pageNumber: page, path, width: 1, height: 1 })
      }
      return { mode: 'visual', pageCount: 6, renderedPages }
    },
  }
}

function pdfAttachment(name: string, pageCount: number): PdfAttachment {
  return {
    id: ATTACHMENT_ID,
    sessionId: SESSION_ID,
    name,
    storageName: `${ATTACHMENT_ID}.pdf`,
    mediaType: 'application/pdf',
    sha256: 'a'.repeat(64),
    byteLength: 123,
    pageCount,
  }
}

function context(projectDir: string) {
  return {
    projectDir,
    additionalDirs: [],
    abortSignal: new AbortController().signal,
  }
}

async function tempDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'whycode-read-pdf-'))
  tempDirectories.push(path)
  return path
}
