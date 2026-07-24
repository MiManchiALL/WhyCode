import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { McpCatalogTool } from './catalog.ts'
import { searchMcpTools, tokenize } from './search.ts'

describe('MCP BM25 工具检索', () => {
  it('同时支持英文词和中日韩双字检索，并按 max_results 截取', () => {
    const tools = [
      tool('calendar', 'Manage calendar events and schedules'),
      tool('files', 'Search source files'),
      tool('weather', '查询城市天气预报'),
    ]
    assert.equal(searchMcpTools(tools, 'calendar schedule', 1)[0]?.tool.rawName, 'calendar')
    assert.equal(searchMcpTools(tools, '天气', 5)[0]?.tool.rawName, 'weather')
    assert.equal(searchMcpTools(tools, 'search', 1).length, 1)
    assert.ok(tokenize('天气 weather').includes('天气'))
  })
})

function tool(name: string, description: string): McpCatalogTool {
  return {
    id: name.padEnd(64, '0').slice(0, 64),
    descriptorHash: name.padEnd(64, '1').slice(0, 64),
    exposedName: `Mcp__server__${name}`,
    serverName: 'server',
    serverScope: 'global',
    rawName: name,
    title: name,
    description,
    inputSchema: { type: 'object' },
    inputSummary: '无已声明参数',
    searchText: `${name}\n${description}`,
    advertisedReadOnly: false,
  }
}
