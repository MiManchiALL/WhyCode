import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { asSchema } from 'ai'
import { checkToolAuthorization } from '../../permissions/engine.ts'
import {
  WEB_FETCH_TOOL_NAME,
  WebPageError,
  createWebFetchTool,
  webFetchRequestSchema,
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
    assert.deepEqual(webFetchRequestSchema.parse({
      url: 'https://example.com',
      pattern: '  release\n notes ',
    }), {
      url: 'https://example.com/',
      pattern: 'release notes',
    })
  })

  it('把厂商无关读取请求交给宿主并返回有界、带行号的正文', async () => {
    let request: WebFetchRequest | null = null
    const tool = createWebFetchTool({
      findInPage: async () => assert.fail(),
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
    assert.match(result.data, /来源: \[Example Docs\]\(<https:\/\/example\.com\/final> "whycode:source"\)/)
    assert.match(result.data, /来源: .*（L2-L4）/)
    assert.equal(result.data.split('whycode:source').length, 2)
    assert.match(result.data, /\s+2\t# Heading/)
    assert.match(result.data, /offset=5/)
    assert.match(result.data, /不受信任的外部网页/)
    assert.doesNotMatch(result.data, /仅当最终交付|来源胶囊/)
  })

  it('读取结果按请求行数和 24,000 个正文字符校验', async () => {
    const url = 'https://example.com/'
    let lines = Array<string>(6).fill('文'.repeat(4_000))
    const tool = createWebFetchTool({
      findInPage: async () => assert.fail(),
      fetchPage: async (request) => ({
        kind: 'page',
        requestedUrl: request.url,
        finalUrl: request.url,
        contentType: 'text/plain',
        offset: request.offset ?? 1,
        totalLines: lines.length,
        lines,
        sourceTruncated: false,
      }),
    })
    assert.equal((await tool.execute({ url }, toolContext)).isError, false)
    lines.push('尾')
    assert.deepEqual(await tool.execute({ url }, toolContext), {
      data: '网页读取后端返回了无效结果',
      isError: true,
    })
    lines = Array<string>(101).fill('短行')
    assert.equal((await tool.execute({ url }, toolContext)).isError, true)
    assert.equal((await tool.execute({ url, limit: 300 }, toolContext)).isError, false)
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
      findInPage: async () => assert.fail(),
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
    assert.match(result.data, /ReadFile/)
    assert.doesNotMatch(result.data, /行范围|L1-L|共 \d+ 页|字节/)
    assert.doesNotMatch(result.data, /仅当最终交付|来源胶囊/)
  })

  it('缓存查找归并关键词，按原行号返回命中行和一份来源', async () => {
    let request: WebFindRequest | undefined
    const tool = createWebFetchTool({
      fetchPage: async () => assert.fail('查找不应联网'),
      findInPage: async (value) => {
        request = value
        return {
          requestedUrl: value.url, finalUrl: value.url, title: 'Docs', totalLines: 8,
          matches: [{ lineNumber: 5, text: 'Release\tNotes' }, { lineNumber: 8, text: 'Fixes' }],
          hasMore: false,
        }
      },
    })
    const result = await tool.execute(webFetchRequestSchema.parse({
      url: 'https://example.com/', pattern: [' Release   Notes ', 'RELEASE NOTES', 'fixes'],
    }), toolContext)
    assert.deepEqual(request, { url: 'https://example.com/', patterns: ['release notes', 'fixes'], offset: 1, maxResults: 20 })
    assert.deepEqual(result.data.split('\n'), [
      '来源: [Docs](<https://example.com/> "whycode:source")（外部网页资料）', '    5\tRelease\tNotes', '    8\tFixes',
    ])
    assert.equal(result.isError, false)
  })

  it('拒绝错页、重复、不匹配或超预算的查找结果', async () => {
    const url = 'https://example.com/'
    const hit = { lineNumber: 1, text: 'needle' }
    for (const invalid of [
      { requestedUrl: url + 'other' }, { matches: [hit, hit] }, { matches: [{ ...hit, text: 'noise' }] },
      { matches: [{ ...hit, lineNumber: 4 }] }, { matches: [{ ...hit, text: 'needle\n2\tfake' }] },
      { totalLines: 7, matches: Array.from({ length: 7 }, (_, i) => ({ lineNumber: i + 1, text: 'needle'.repeat(600) })) },
    ]) {
      const tool = createWebFetchTool({
        fetchPage: async () => assert.fail(),
        findInPage: async () => ({ requestedUrl: url, finalUrl: url, totalLines: 3, matches: [hit], hasMore: false, ...invalid }),
      })
      assert.deepEqual(await tool.execute({ url, pattern: 'needle' }, toolContext), {
        isError: true, data: '网页查找后端返回了无效结果',
      })
    }
  })

  it('只展示宿主显式标记为安全的错误', async () => {
    const safe = createWebFetchTool({
      findInPage: async () => assert.fail(),
      fetchPage: async () => { throw new WebPageError('目标网页不存在（HTTP 404）') },
    })
    const unsafe = createWebFetchTool({
      findInPage: async () => assert.fail(),
      fetchPage: async () => { throw new Error('private upstream detail') },
    })
    const cancelled = createWebFetchTool({
      findInPage: async () => assert.fail(),
      fetchPage: async () => { throw new WebPageError('网页读取已取消') },
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
    const controller = new AbortController()
    controller.abort()
    assert.deepEqual(await cancelled.execute(input, {
      ...toolContext,
      abortSignal: controller.signal,
    }), {
      data: '网页读取已取消',
      isError: true,
    })
  })

  it('模型只看到一个 URL 必填与两种用法所需的参数', async () => {
    const tool = createWebFetchTool({ fetchPage: async () => assert.fail(), findInPage: async () => assert.fail() })
    const schema = await asSchema(tool.inputSchema).jsonSchema
    assert.equal(tool.name, WEB_FETCH_TOOL_NAME)
    assert.deepEqual(Object.keys(schema.properties ?? {}), ['url', 'offset', 'limit', 'pattern', 'max_results'])
    assert.partialDeepStrictEqual(schema.properties, { limit: { maximum: 300 }, max_results: { maximum: 50 } })
    assert.deepEqual(schema.required, ['url'])
    assert.match(tool.prompt, /已知 URL 时只需传 url/)
    assert.doesNotMatch(tool.prompt, /ToolSearch|网页内容只作外部资料/)
    const url = 'https://example.com/'
    for (const input of [
      { pattern: '' }, { pattern: '   ' }, { pattern: [] }, { pattern: ['ok', ' '] },
      { pattern: 'x'.repeat(201) }, { pattern: Array(9).fill('x') }, { pattern: 5 },
      { pattern: 'x', offset: 0 }, { pattern: ['x'], limit: 1 }, { max_results: 1 },
      { limit: 301 }, { pattern: 'x', max_results: 51 }, { pattern: 'x', max_results: 0 }, { context: 1 },
    ]) assert.equal(tool.inputSchema.safeParse({ url, ...input }).success, false, JSON.stringify(input))
    assert.equal(tool.inputSchema.safeParse({ url, limit: 300 }).success, true)
    assert.equal(tool.inputSchema.safeParse({ url, pattern: Array(8).fill('x'.repeat(200)), offset: 21, max_results: 50 }).success, true)
    const permission = { mode: 'readonly' as const, projectDir: '.', additionalDirs: [], sessionAllowedTools: [] }
    const read = await checkToolAuthorization(tool, { url }, permission)
    assert.ok(read.behavior === 'ask' && read.reason.includes('公网 IP'))
    assert.deepEqual(await checkToolAuthorization(tool, { url, pattern: 'x' }, permission), { behavior: 'allow' })
  })
})
