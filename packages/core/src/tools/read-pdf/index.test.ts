import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { z } from 'zod'
import type { PdfAttachment } from '../../pdf/types.ts'
import type { PdfProcessor } from '../../pdf/processor.ts'
import { createReadPdfTool } from './index.ts'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const ATTACHMENT_ID = '22222222-2222-4222-8222-222222222222'
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
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
        pageCount: 12,
        pages: [
          { pageNumber: 3, text: '第三页' },
          { pageNumber: 4, text: 'x'.repeat(70_000) },
        ],
        renderedPages: [],
      }, (options) => assert.equal(options.expectedSha256, attachment.sha256)),
      supportsVisual: false,
      supportsProjectPaths: false,
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

  it('视觉模式将每页渲染图导入会话，并限制为最多四页', async () => {
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
      supportsProjectPaths: false,
      resolveAttachment: () => ({ attachment, path: sourcePath }),
    })
    const tooMany = tool.inputSchema.parse({
      sourceType: 'attachment',
      sourceValue: ATTACHMENT_ID,
      mode: 'visual',
      pageCount: 5,
    })
    assert.equal((await tool.execute(tooMany, context(root))).isError, true)

    const input = tool.inputSchema.parse({
      sourceType: 'attachment',
      sourceValue: ATTACHMENT_ID,
      mode: 'visual',
      startPage: 2,
      pageCount: 2,
    })
    const result = await tool.execute(input, context(root))
    assert.equal(result.isError, false)
    assert.deepEqual(result.attachments?.map((item) => item.name), [
      'slides · 第 2 页.png',
      'slides · 第 3 页.png',
    ])
    assert.equal(result.imageTransform?.detail, 'high')
  })

  it('非视觉模型的 schema 物理拒绝 visual，纯聊天也不暴露 path 来源', () => {
    const tool = createReadPdfTool({
      attachmentDirectory: 'unused',
      sessionId: SESSION_ID,
      processor: fakeProcessor({ pageCount: 1, pages: [], renderedPages: [] }),
      supportsVisual: false,
      supportsProjectPaths: false,
      resolveAttachment: () => null,
    })
    assert.equal(tool.inputSchema.safeParse({
      sourceType: 'attachment',
      sourceValue: ATTACHMENT_ID,
      mode: 'visual',
    }).success, false)
    assert.equal(tool.inputSchema.safeParse({
      sourceType: 'path',
      sourceValue: 'secret.pdf',
    }).success, false)
    assert.equal(tool.inputSchema.safeParse({
      sourceType: 'attachment',
      sourceValue: 'not-an-attachment-id',
    }).success, false)
  })

  it('所有模型共享扁平来源契约，项目路径仍进入权限提取', () => {
    const tool = createReadPdfTool({
      attachmentDirectory: 'unused',
      sessionId: SESSION_ID,
      processor: fakeProcessor({ pageCount: 1, pages: [], renderedPages: [] }),
      supportsVisual: false,
      supportsProjectPaths: true,
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

function renderingProcessor(): PdfProcessor {
  return {
    async inspect() {
      return { pageCount: 6, byteLength: 1 }
    },
    async readPages(_path, options) {
      await mkdir(options.outputDirectory!, { recursive: true })
      const renderedPages = []
      const pages = []
      for (let page = options.startPage; page < options.startPage + options.pageCount; page++) {
        const path = join(options.outputDirectory!, `page-${page}.png`)
        await writeFile(path, ONE_PIXEL_PNG)
        renderedPages.push({ pageNumber: page, path, width: 1, height: 1 })
        pages.push({ pageNumber: page, text: `第 ${page} 页` })
      }
      return { pageCount: 6, pages, renderedPages }
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
