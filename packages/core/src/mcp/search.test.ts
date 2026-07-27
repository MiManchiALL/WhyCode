import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { McpCatalogTool } from './catalog.ts'
import {
  McpToolSearchIndex,
  searchMcpTools,
  tokenize,
} from './search.ts'

describe('MCP BM25 工具检索', () => {
  it('同时支持英文词形、camelCase 与中日韩双字检索', () => {
    const tools = [
      tool('manage_calendar', 'Manage calendar events and schedules'),
      tool('search_files', 'Search source files'),
      tool('weather', '查询城市天气预报'),
    ]

    assert.equal(searchMcpTools(tools, 'calendar schedules', 1)[0]?.tool.rawName, 'manage_calendar')
    assert.equal(searchMcpTools(tools, '天气', 5)[0]?.tool.rawName, 'weather')
    assert.equal(searchMcpTools(tools, 'search', 1).length, 1)
    assert.deepEqual(
      tokenize('getFileContents repositories').filter((term) =>
        ['read', 'file', 'content', 'repositori'].includes(term)),
      ['read', 'file', 'content', 'repositori'],
    )
    assert.ok(tokenize('天气 weather').includes('天气'))
  })

  it('真实仓库读取意图优先命中 get_file_contents，而不是邻近 GitHub 工具', () => {
    const tools = githubTools()

    assert.equal(
      searchMcpTools(tools, 'GitHub file contents get read', 5)[0]?.tool.rawName,
      'get_file_contents',
    )
    assert.equal(
      searchMcpTools(tools, 'github list repository files contents get content', 8)[0]?.tool.rawName,
      'get_file_contents',
    )
  })

  it('只索引紧凑的顶层参数元数据，不让深层 schema 噪声淹没工具身份', () => {
    const target = tool(
      'get_file_contents',
      'Get the contents of a file or directory from a GitHub repository',
      {
        owner: 'Repository owner',
        repo: 'Repository name',
        path: 'Path to file or directory',
      },
    )
    const noise = tool('audit_policy', 'Inspect repository policy status', {
      options: {
        type: 'object',
        properties: {
          repeated: {
            type: 'string',
            description: 'file contents repository read '.repeat(200),
          },
        },
      },
    })

    assert.equal(
      searchMcpTools([noise, target], 'read repository file contents', 2)[0]?.tool.rawName,
      'get_file_contents',
    )
  })

  it('目录描述符未变化时索引仍有效，变化后要求重建', () => {
    const tools = githubTools()
    const index = new McpToolSearchIndex(tools)

    assert.equal(index.matches([...tools]), true)
    assert.equal(index.matches([
      { ...tools[0]!, descriptorHash: 'f'.repeat(64) },
      ...tools.slice(1),
    ]), false)
  })
})

function githubTools(): McpCatalogTool[] {
  return [
    tool(
      'get_file_contents',
      'Get the contents of a file or directory from a GitHub repository',
      {
        owner: 'Repository owner (username or organization)',
        repo: 'Repository name',
        path: 'Path to file/directory',
        ref: 'Optional git ref',
      },
      'Get file or directory contents',
    ),
    tool(
      'pull_request_read',
      'Get details, comments, reviews, commits, status and changed files for a pull request',
      { owner: 'Repository owner', repo: 'Repository name', pullNumber: 'Pull request number' },
    ),
    tool(
      'run_secret_scanning',
      'Run secret scanning against files in a GitHub repository',
      { owner: 'Repository owner', repo: 'Repository name' },
    ),
    tool(
      'issue_read',
      'Get issue details and comments from a GitHub repository',
      { owner: 'Repository owner', repo: 'Repository name', issueNumber: 'Issue number' },
    ),
    tool(
      'get_commit',
      'Get details for a commit in a GitHub repository',
      { owner: 'Repository owner', repo: 'Repository name', sha: 'Commit SHA' },
    ),
    tool(
      'get_latest_release',
      'Get the latest release for a GitHub repository',
      { owner: 'Repository owner', repo: 'Repository name' },
    ),
    tool(
      'search_repositories',
      'Search for GitHub repositories',
      { query: 'Repository search query' },
    ),
  ]
}

function tool(
  name: string,
  description: string,
  parameters: Record<string, string | Record<string, unknown>> = {},
  title = name,
): McpCatalogTool {
  return {
    id: name.padEnd(64, '0').slice(0, 64),
    descriptorHash: name.padEnd(64, '1').slice(0, 64),
    exposedName: `Mcp__github__${name}`,
    serverName: 'github',
    serverScope: 'global',
    rawName: name,
    title,
    description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(parameters).map(([key, value]) => [
        key,
        typeof value === 'string' ? { type: 'string', description: value } : value,
      ])),
    },
    inputSummary: Object.keys(parameters).join(', ') || '无已声明参数',
    advertisedReadOnly: true,
  }
}
