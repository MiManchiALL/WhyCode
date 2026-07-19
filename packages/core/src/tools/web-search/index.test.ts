import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  WEB_SEARCH_MAX_SNIPPET_CHARS,
  WebSearchError,
  createWebSearchTool,
  webSearchRequestSchema,
  type WebSearchRequest,
} from './index.ts'

const toolContext = {
  projectDir: 'C:\\workspace',
  additionalDirs: [],
  abortSignal: new AbortController().signal,
}

describe('WebSearch 工具契约', () => {
  it('归一化查询、域名并提供有界默认结果数', () => {
    assert.deepEqual(webSearchRequestSchema.parse({
      query: '  WhyCode\nweb search  ',
      domains: ['Example.COM', 'example.com'],
    }), {
      query: 'WhyCode web search',
      max_results: 5,
      domains: ['example.com'],
    })
    assert.equal(webSearchRequestSchema.safeParse({
      query: 'test',
      domains: ['https://example.com/path'],
    }).success, false)
    assert.deepEqual(webSearchRequestSchema.parse({
      query: [' first\nquery ', ' second query '],
    }).query, ['first query', 'second query'])
    assert.equal(webSearchRequestSchema.safeParse({
      query: ['same query', 'same query'],
    }).success, false)
  })

  it('把厂商无关输入交给宿主并输出可引用的有界结果', async () => {
    let request: WebSearchRequest | null = null
    const tool = createWebSearchTool({
      search: async (value) => {
        request = value
        return {
          results: [
            {
              title: '  官方\n文档  ',
              url: 'https://example.com/docs',
              snippet: 'A'.repeat(WEB_SEARCH_MAX_SNIPPET_CHARS + 20),
              publishedDate: '2026-07-19',
            },
            {
              title: '无效来源',
              url: 'file:///C:/secret.txt',
              snippet: '不能进入结果',
            },
          ],
        }
      },
    })

    const result = await tool.execute({
      query: 'WhyCode',
      max_results: 3,
      recency: 'week',
      domains: ['example.com'],
    }, toolContext)

    assert.deepEqual(request, {
      queries: ['WhyCode'],
      maxResults: 3,
      recency: 'week',
      domains: ['example.com'],
    })
    assert.equal(result.isError, false)
    assert.match(result.data, /\[官方 文档\]\(<https:\/\/example\.com\/docs>\)/)
    assert.match(result.data, /不受信任的外部网页/)
    assert.doesNotMatch(result.data, /file:\/\/|不能进入结果/)
    assert.equal(result.data.includes('A'.repeat(WEB_SEARCH_MAX_SNIPPET_CHARS + 1)), false)
  })

  it('批量查询共享筛选条件并限制单次总结果数', async () => {
    let request: WebSearchRequest | null = null
    const tool = createWebSearchTool({
      search: async (value) => {
        request = value
        return { results: [] }
      },
    })

    await tool.execute({
      query: ['query one', 'query two', 'query three', 'query four'],
      max_results: 10,
    }, toolContext)

    assert.deepEqual(request, {
      queries: ['query one', 'query two', 'query three', 'query four'],
      maxResults: 5,
    })
  })

  it('只展示宿主显式标记为安全的错误', async () => {
    const safeTool = createWebSearchTool({
      search: async () => { throw new WebSearchError('尚未配置网页搜索密钥') },
    })
    const unsafeTool = createWebSearchTool({
      search: async () => { throw new Error('Bearer secret-value') },
    })
    const invalidTool = createWebSearchTool({
      search: async () => ({
        results: [{ title: 'invalid', url: 'file:///secret', snippet: 'content' }],
      }),
    })
    const input = { query: 'test', max_results: 5 }

    assert.deepEqual(await safeTool.execute(input, toolContext), {
      data: '尚未配置网页搜索密钥',
      isError: true,
    })
    assert.deepEqual(await unsafeTool.execute(input, toolContext), {
      data: '网页搜索暂时不可用',
      isError: true,
    })
    assert.deepEqual(await invalidTool.execute(input, toolContext), {
      data: '网页搜索后端返回了无效结果',
      isError: true,
    })
  })

  it('无项目可用，但首次使用必须告知搜索词会发往外部服务', () => {
    const tool = createWebSearchTool({ search: async () => ({ results: [] }) })
    assert.equal(tool.availableWithoutProject, true)
    assert.equal(tool.isReadOnly, true)
    assert.match(tool.initialApprovalReason ?? '', /搜索词.*外部搜索服务/)
  })
})
