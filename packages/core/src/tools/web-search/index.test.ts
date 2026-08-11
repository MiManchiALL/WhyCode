import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT } from '../web-source.ts'
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
            {
              title: '重复来源',
              url: 'https://example.com/docs#section',
              snippet: '不应重复进入结果',
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
    assert.match(result.data, /结果 1：\[官方 文档\]/)
    assert.doesNotMatch(result.data, /\[S1\]/)
    assert.match(result.data, /\[官方 文档\]\(<https:\/\/example\.com\/docs>\)/)
    assert.match(result.data, /不受信任的外部网页/)
    assert.equal(result.data.endsWith(WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT), true)
    assert.doesNotMatch(result.data, /file:\/\/|不能进入结果/)
    assert.doesNotMatch(result.data, /重复来源|不应重复进入结果/)
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

  it('批量查询保留成功来源并明确展示部分失败', async () => {
    const tool = createWebSearchTool({
      search: async () => ({
        results: [{
          title: '成功来源',
          url: 'https://example.com/result',
          snippet: 'available result',
        }],
        failures: [{
          query: 'failed query',
          message: '搜索请求过于频繁',
        }],
      }),
    })

    const result = await tool.execute({
      query: ['successful query', 'failed query'],
      max_results: 3,
    }, toolContext)

    assert.equal(result.isError, false)
    assert.match(result.data, /部分查询未完成（1\/2）/)
    assert.match(result.data, /"failed query"：搜索请求过于频繁/)
    assert.match(result.data, /\[成功来源\]\(<https:\/\/example\.com\/result>\)/)
    assert.equal(result.data.endsWith(WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT), true)
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

  it('首次使用必须告知搜索词会发往外部服务', () => {
    const tool = createWebSearchTool({ search: async () => ({ results: [] }) })
    assert.equal(tool.isReadOnly, true)
    assert.match(tool.initialApprovalReason ?? '', /搜索词.*外部搜索服务/)
    assert.match(tool.prompt, /当前状态、近期变化、有效性、实际覆盖范围或出处/)
    assert.match(tool.prompt, /当前上下文没有直接来源证据/)
    assert.match(tool.prompt, /不能仅以模型记忆作为依据/)
    assert.doesNotMatch(tool.prompt, /已知的稳定事实不必搜索/)
    assert.doesNotMatch(tool.prompt, /需要核实时使用/)
    assert.match(tool.prompt, /互不重复、可独立作答/)
  })
})
