import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type {
  OfficeArtifactBuildRequest,
  OfficeArtifactRunner,
  OfficeInspection,
  OfficeProcessor,
} from '../office/types.ts'
import { createBuildOfficeArtifactTool } from './build-office-artifact/index.ts'
import { createInspectOfficeTool } from './inspect-office/index.ts'
import { createRenderOfficeTool } from './render-office/index.ts'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const SMALL_JPEG = Buffer.from(
  '/9j/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AD//Z',
  'base64',
)
const tempDirectories: string[] = []

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })))
})

describe('Office tools', () => {
  it('BuildOfficeArtifact 解析路径、建立精确检查点并回报验证摘要', async () => {
    const root = await tempDirectory()
    let captured: OfficeArtifactBuildRequest | null = null
    const runner: OfficeArtifactRunner = {
      async build(request) {
        captured = request
        return { outputPath: request.outputPath, inspection: inspection('docx') }
      },
    }
    const tool = createBuildOfficeArtifactTool(runner)
    const input = tool.inputSchema.parse({
      format: 'docx',
      scriptPath: 'builders/report.js',
      outputPath: 'artifacts/report.docx',
      assets: [{ key: 'logo', path: 'assets/logo.png' }],
    })
    const ctx = context(root)
    const result = await tool.execute(input, ctx)

    assert.equal(tool.kind, 'execute')
    assert.deepEqual(tool.extractPaths?.(input), [
      'builders/report.js', 'artifacts/report.docx', 'assets/logo.png',
    ])
    assert.deepEqual(await tool.checkpointScope?.(input, ctx), {
      kind: 'exact-files', paths: [join(root, 'artifacts', 'report.docx')],
    })
    assert.deepEqual(captured, {
      format: 'docx',
      scriptPath: join(root, 'builders', 'report.js'),
      outputPath: join(root, 'artifacts', 'report.docx'),
      assets: [{ key: 'logo', path: join(root, 'assets', 'logo.png') }],
    })
    assert.match(result.data, /通过 OOXML 结构校验/)
    assert.match(result.data, /SHA-256 a{64}/)
    assert.equal(tool.inputSchema.safeParse({
      format: 'docx', scriptPath: 'x.js', outputPath: 'x.pptx',
    }).success, false)
  })

  it('InspectOffice 分页返回结构内容与不可信资料边界', async () => {
    const root = await tempDirectory()
    let capturedPath = ''
    const processor = processorStub()
    processor.inspect = async (path, options) => {
      capturedPath = path
      assert.deepEqual(options, { startUnit: 3, unitCount: 2, sheetName: '数据' })
      return {
        ...inspection('xlsx'),
        unitKind: 'row',
        unitCount: 5,
        units: [{ index: 3, label: '第 3 行', text: 'A3=结果' }],
        nextUnit: 4,
      }
    }
    const tool = createInspectOfficeTool(processor)
    const input = tool.inputSchema.parse({
      path: 'artifacts/data.xlsx', startUnit: 3, unitCount: 2, sheetName: '数据',
    })
    const result = await tool.execute(input, context(root))

    assert.equal(capturedPath, join(root, 'artifacts', 'data.xlsx'))
    assert.match(result.data, /--- 第 3 行 ---/)
    assert.match(result.data, /startUnit=4/)
    assert.match(result.data, /不可信资料/)
  })

  it('RenderOffice 后台渲染并把页面图直接导入当前会话', async () => {
    const root = await tempDirectory()
    const attachmentDirectory = join(root, 'attachments')
    const tool = createRenderOfficeTool({
      attachmentDirectory,
      sessionId: SESSION_ID,
      processor: processorStub(async (_path, options) => {
        await mkdir(options.outputDirectory, { recursive: true })
        const renderedPages = []
        for (let page = options.startPage; page < options.startPage + options.pageCount; page++) {
          const path = join(options.outputDirectory, `page-${page}.jpg`)
          await writeFile(path, SMALL_JPEG)
          renderedPages.push({ pageNumber: page, path, width: 4, height: 4 })
        }
        return { format: 'pptx', pageCount: 5, renderer: 'microsoft-office', renderedPages }
      }),
    })
    const input = tool.inputSchema.parse({ path: 'slides.pptx', startPage: 2, pageCount: 2 })
    const result = await tool.execute(input, context(root))

    assert.equal(tool.requiresStandaloneStep, true)
    assert.equal(result.attachments?.length, 2)
    assert.deepEqual(result.attachments?.map((attachment) => attachment.name), [
      'slides.pptx · 渲染第 2 页.jpg',
      'slides.pptx · 渲染第 3 页.jpg',
    ])
    assert.equal(result.imageTransform?.detail, 'high')
    assert.match(result.data, /Microsoft Office 隐藏实例/)
    assert.match(result.data, /startPage=4/)
    assert.equal(tool.inputSchema.safeParse({ path: 'slides.pptx', pageCount: 5 }).success, false)
  })
})

function processorStub(
  render?: OfficeProcessor['renderPages'],
): OfficeProcessor {
  return {
    async inspect() {
      return inspection('docx')
    },
    renderPages: render ?? (async () => {
      throw new Error('unexpected render')
    }),
  }
}

function inspection(format: 'docx' | 'pptx' | 'xlsx'): OfficeInspection {
  return {
    format,
    byteLength: 1_234,
    sha256: 'a'.repeat(64),
    unitKind: format === 'pptx' ? 'slide' : format === 'xlsx' ? 'sheet' : 'block',
    unitCount: 1,
    units: [{ index: 1, label: '单元 1', text: '内容' }],
    nextUnit: null,
    metadata: ['外部关系 0'],
    formulaCount: 0,
    formulaErrorCount: 0,
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
  const path = await mkdtemp(join(tmpdir(), 'whycode-office-tools-'))
  tempDirectories.push(path)
  return path
}
