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
        return {
          outputPath: request.outputPath,
          inspection: inspection('docx'),
          template: {
            templateSha256: 'b'.repeat(64),
            templatePartCount: 10,
            outputPartCount: 11,
            addedPartCount: 1,
            removedPartCount: 0,
            protectedPartCount: 4,
            modifiedProtectedParts: [],
          },
        }
      },
    }
    const tool = createBuildOfficeArtifactTool(runner)
    const input = tool.inputSchema.parse({
      format: 'docx',
      mode: 'template',
      scriptPath: 'builders/report.js',
      outputPath: 'artifacts/report.docx',
      assets: [
        { key: 'logo', path: 'assets/logo.png' },
        { key: 'template', path: 'assets/template.docx' },
      ],
      templateAssetKey: 'template',
    })
    const ctx = context(root)
    const result = await tool.execute(input, ctx)

    assert.equal(tool.kind, 'execute')
    assert.match(tool.prompt, /OfficeTemplate\.pptx\(\{ template: assets\.template\.bytes, slides \}\)/)
    assert.match(tool.prompt, /不要用相同参数盲目重试/)
    assert.deepEqual(tool.extractPaths?.(input), [
      'builders/report.js', 'artifacts/report.docx', 'assets/logo.png', 'assets/template.docx',
    ])
    assert.deepEqual(await tool.checkpointScope?.(input, ctx), {
      kind: 'exact-files', paths: [join(root, 'artifacts', 'report.docx')],
    })
    assert.deepEqual(captured, {
      format: 'docx',
      mode: 'template',
      scriptPath: join(root, 'builders', 'report.js'),
      outputPath: join(root, 'artifacts', 'report.docx'),
      assets: [
        { key: 'logo', path: join(root, 'assets', 'logo.png') },
        { key: 'template', path: join(root, 'assets', 'template.docx') },
      ],
      templateAssetKey: 'template',
    })
    assert.match(result.data, /通过 OOXML 结构校验/)
    assert.match(result.data, /SHA-256 a{64}/)
    assert.match(result.data, /模板继承/)
    assert.equal(tool.inputSchema.safeParse({
      format: 'docx', mode: 'create', scriptPath: 'x.js', outputPath: 'x.pptx',
    }).success, false)
    assert.equal(tool.inputSchema.safeParse({
      format: 'docx', mode: 'template', scriptPath: 'x.js', outputPath: 'x.docx',
      templateAssetKey: 'missing',
    }).success, false)
    assert.equal(tool.inputSchema.safeParse({
      format: 'docx', mode: 'template', scriptPath: 'x.js', outputPath: 'x.docx',
    }).success, false)
    assert.equal(tool.inputSchema.safeParse({
      format: 'docx', mode: 'create', scriptPath: 'x.js', outputPath: 'x.docx',
      assets: [{ key: 'template', path: 'template.docx' }], templateAssetKey: 'template',
    }).success, false)
    assert.equal(tool.inputSchema.safeParse({
      format: 'docx', mode: 'template', scriptPath: 'x.js', outputPath: 'x.docx',
      assets: [{ key: 'template', path: 'template.docx' }], baselineAssetKey: 'template',
    }).success, false)
  })

  it('InspectOffice 分页返回结构内容与不可信资料边界', async () => {
    const root = await tempDirectory()
    let capturedPath = ''
    const processor = processorStub()
    processor.inspect = async (path, options) => {
      capturedPath = path
      assert.deepEqual(options, {
        startUnit: 3,
        unitCount: 2,
        view: 'content',
        sheetName: '数据',
      })
      return {
        ...inspection('xlsx'),
        unitKind: 'row',
        unitCount: 5,
        units: [{
          index: 3,
          label: '第 3 行',
          kind: 'row',
          locator: '数据!3:3',
          text: 'A3=结果',
        }],
        nextUnit: 4,
        validation: {
          ...inspection('xlsx').validation,
          issues: Array.from({ length: 6 }, (_, index) => ({
            code: `warning-${index + 1}`,
            severity: 'warning' as const,
            location: `part.xml#${index + 1}`,
            message: `issue-${index + 1}`,
          })),
        },
      }
    }
    const tool = createInspectOfficeTool(processor)
    const input = tool.inputSchema.parse({
      path: 'artifacts/data.xlsx', startUnit: 3, unitCount: 2, sheetName: '数据',
    })
    const result = await tool.execute(input, context(root))

    assert.equal(capturedPath, join(root, 'artifacts', 'data.xlsx'))
    assert.match(result.data, /--- 第 3 行 \[row\] ---/)
    assert.match(result.data, /startUnit=4/)
    assert.match(result.data, /不可信资料/)
    assert.match(result.data, /其余 1 个校验问题请用 view=validation/)
    assert.doesNotMatch(result.data, /issue-6/)
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
    assert.equal(input.view, 'pages')
    assert.equal(result.attachments?.length, 2)
    assert.deepEqual(result.attachments?.map((attachment) => attachment.name), [
      'slides.pptx · 渲染第 2 页.jpg',
      'slides.pptx · 渲染第 3 页.jpg',
    ])
    assert.equal(result.imageTransform?.detail, 'high')
    assert.match(result.data, /Microsoft Office 隐藏实例/)
    assert.match(result.data, /startPage=4/)
    assert.equal(tool.inputSchema.safeParse({ path: 'slides.pptx', pageCount: 5 }).success, false)
    assert.equal(tool.inputSchema.safeParse({
      path: 'slides.pptx', view: 'overview', pageCount: 5,
    }).success, true)
  })

  it('RenderOffice 把多页合成单张整套构图总览', async () => {
    const root = await tempDirectory()
    const tool = createRenderOfficeTool({
      attachmentDirectory: join(root, 'attachments'),
      sessionId: SESSION_ID,
      processor: processorStub(async (_path, options) => {
        assert.equal(options.view, 'overview')
        await mkdir(options.outputDirectory, { recursive: true })
        const renderedPages = []
        for (let page = options.startPage; page < options.startPage + options.pageCount; page++) {
          const path = join(options.outputDirectory, `page-${page}.jpg`)
          await writeFile(path, SMALL_JPEG)
          renderedPages.push({ pageNumber: page, path, width: 4, height: 4 })
        }
        return { format: 'pptx', pageCount: 8, renderer: 'microsoft-office', renderedPages }
      }),
    })
    const input = tool.inputSchema.parse({
      path: 'slides.pptx', view: 'overview', startPage: 1, pageCount: 5,
    })
    const result = await tool.execute(input, context(root))

    assert.equal(result.attachments?.length, 1)
    assert.equal(result.attachments?.[0]?.name, 'slides.pptx · 总览第 1-5 页.jpg')
    assert.ok((result.attachments?.[0]?.width ?? 0) > 1_000)
    assert.match(result.data, /整套构图总览/)
    assert.match(result.data, /文字适配.*pages 逐页检查/)
    assert.equal(tool.inputSchema.safeParse({
      path: 'slides.pptx', view: 'overview', pageCount: 51,
    }).success, false)
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
    units: [{
      index: 1,
      label: '单元 1',
      kind: format === 'pptx' ? 'slide' : format === 'xlsx' ? 'worksheet' : 'paragraph',
      locator: 'part.xml#1',
      text: '内容',
    }],
    nextUnit: null,
    metadata: ['外部关系 0'],
    validation: {
      checkedPartCount: 4,
      relationshipCount: 3,
      internalRelationshipCount: 3,
      issues: [],
    },
    formulaCount: 0,
    formulaErrorCount: 0,
    formulaUncalculatedCount: 0,
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
