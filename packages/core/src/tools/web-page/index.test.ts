import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT } from '../web-source.ts'
import {
  WEB_FETCH_MAX_OUTPUT_CHARS,
  WEB_FETCH_TOOL_NAME,
  WEB_FIND_TOOL_NAME,
  WebPageError,
  createWebFetchTool,
  createWebFindTool,
  webFetchRequestSchema,
  webFindRequestSchema,
  type WebFetchRequest,
  type WebFindRequest,
} from './index.ts'

const toolContext = {
  projectDir: 'C:\\workspace',
  additionalDirs: [],
  abortSignal: new AbortController().signal,
}

describe('网页读取工具契约', () => {
  it('归一化 URL 与分页默认值，并拒绝非网页协议和凭据', () => {
    assert.deepEqual(webFetchRequestSchema.parse({
      url: ' https://Example.com/docs#part ',
    }), {
      url: 'https://example.com/docs',
    })
    assert.equal(webFetchRequestSchema.safeParse({ url: 'file:///C:/secret' }).success, false)
    assert.equal(webFetchRequestSchema.safeParse({
      url: 'https://user:password@example.com/',
    }).success, false)
    assert.deepEqual(webFindRequestSchema.parse({
      url: 'https://example.com',
      pattern: '  release\n notes ',
    }), {
      url: 'https://example.com/',
      pattern: 'release notes',
      context: 2,
      max_results: 10,
    })
  })

  it('把厂商无关读取请求交给宿主并返回有界、带行号的正文', async () => {
    let request: WebFetchRequest | null = null
    const tool = createWebFetchTool({
      fetchPage: async (value) => {
        request = value
        return {
          kind: 'page',
          requestedUrl: value.url,
          finalUrl: 'https://example.com/final',
          title: 'Example Docs',
          contentType: 'text/html',
          offset: value.offset ?? 1,
          totalLines: 5,
          lines: ['# Heading', '', '正文内容'],
          sourceTruncated: false,
        }
      },
    })

    const result = await tool.execute({
      url: 'https://example.com/start',
      offset: 2,
      limit: 3,
    }, toolContext)

    assert.deepEqual(request, {
      url: 'https://example.com/start',
      offset: 2,
      limit: 3,
    })
    assert.equal(result.isError, false)
    assert.match(result.data, /来源: \[Example Docs\]\(<https:\/\/example\.com\/final>\)/)
    assert.match(result.data, /证据范围: .*（L2-L4）/)
    assert.match(result.data, /\s+2\t# Heading/)
    assert.match(result.data, /offset=5/)
    assert.match(result.data, /不受信任的外部网页/)
    assert.equal(result.data.endsWith(WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT), true)
  })

  it('拒绝超出输出预算或结构无效的宿主结果', async () => {
    const oversized = createWebFetchTool({
      fetchPage: async (request) => ({
        kind: 'page',
        requestedUrl: request.url,
        finalUrl: request.url,
        contentType: 'text/plain',
        offset: request.offset ?? 1,
        totalLines: 3,
        lines: ['A'.repeat(4_000), 'B'.repeat(4_000), 'C'.repeat(1_100)],
        sourceTruncated: false,
      }),
    })
    const result = await oversized.execute({
      url: 'https://example.com/',
      offset: 1,
      limit: 3,
    }, toolContext)

    assert.deepEqual(result, {
      data: '网页读取后端返回了无效结果',
      isError: true,
    })
    assert.equal(WEB_FETCH_MAX_OUTPUT_CHARS, 9_000)
  })

  it('远程 PDF 只返回会话附件引用，不伪造行分页', async () => {
    const attachment = {
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      name: 'report.pdf',
      storageName: '11111111-1111-4111-8111-111111111111.pdf',
      mediaType: 'application/pdf' as const,
      origin: 'web' as const,
      sha256: 'a'.repeat(64),
      byteLength: 1_024,
      pageCount: 12,
    }
    let request: WebFetchRequest | null = null
    const tool = createWebFetchTool({
      fetchPage: async (value) => {
        request = value
        return {
          kind: 'pdf',
          requestedUrl: value.url,
          finalUrl: value.url,
          contentType: 'application/pdf',
          attachment,
        }
      },
    })

    const result = await tool.execute({ url: 'https://example.com/report.pdf' }, toolContext)

    assert.deepEqual(request, { url: 'https://example.com/report.pdf' })
    assert.equal(result.isError, false)
    assert.deepEqual(result.pdfAttachments, [attachment])
    assert.match(result.data, /PDF 已保存为当前会话附件/)
    assert.match(result.data, new RegExp(attachment.id))
    assert.match(result.data, /ReadPdf/)
    assert.doesNotMatch(result.data, /行范围|L1-L/)
    assert.equal(result.data.endsWith(WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT), true)
  })

  it('WebFind 不需要网络审批，并返回匹配上下文的稳定行号', async () => {
    let request: WebFindRequest | null = null
    const tool = createWebFindTool({
      findInPage: async (value) => {
        request = value
        return {
          requestedUrl: value.url,
          finalUrl: value.url,
          title: 'Docs',
          totalLines: 8,
          matches: [{
            lineNumber: 5,
            context: [
              { lineNumber: 4, text: 'before' },
              { lineNumber: 5, text: 'Release Notes' },
              { lineNumber: 6, text: 'after' },
            ],
          }],
        }
      },
    })

    const result = await tool.execute({
      url: 'https://example.com/',
      pattern: 'release',
      context: 1,
      max_results: 2,
    }, toolContext)

    assert.deepEqual(request, {
      url: 'https://example.com/',
      pattern: 'release',
      context: 1,
      maxResults: 2,
    })
    assert.equal(result.isError, false)
    assert.match(result.data, /匹配 1：第 5 行/)
    assert.match(result.data, /证据范围: .*（L4-L6）/)
    assert.match(result.data, /\s+5\tRelease Notes/)
    assert.equal(result.data.endsWith(WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT), true)
    assert.equal(tool.initialApprovalReason, undefined)
  })

  it('只展示宿主显式标记为安全的错误', async () => {
    const safe = createWebFetchTool({
      fetchPage: async () => { throw new WebPageError('目标网页不存在（HTTP 404）') },
    })
    const unsafe = createWebFetchTool({
      fetchPage: async () => { throw new Error('private upstream detail') },
    })
    const input = { url: 'https://example.com/', offset: 1, limit: 10 }

    assert.deepEqual(await safe.execute(input, toolContext), {
      data: '目标网页不存在（HTTP 404）',
      isError: true,
    })
    assert.deepEqual(await unsafe.execute(input, toolContext), {
      data: '网页读取暂时不可用',
      isError: true,
    })
  })

  it('两个工具都可在无项目主会话使用，只有联网读取首次提示隐私风险', () => {
    const fetchTool = createWebFetchTool({ fetchPage: async () => {
      throw new WebPageError('unused')
    } })
    const findTool = createWebFindTool({ findInPage: async () => {
      throw new WebPageError('unused')
    } })
    assert.equal(fetchTool.name, WEB_FETCH_TOOL_NAME)
    assert.equal(findTool.name, WEB_FIND_TOOL_NAME)
    assert.equal(fetchTool.availableWithoutProject, true)
    assert.equal(findTool.availableWithoutProject, true)
    assert.match(fetchTool.initialApprovalReason ?? '', /公网 IP/)
    assert.equal(findTool.initialApprovalReason, undefined)
  })
})
