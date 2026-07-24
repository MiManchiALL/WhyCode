import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { McpStdioServerConfig } from './config.ts'
import { buildServerCatalog } from './catalog.ts'
import { mergeLoadedMcpTools } from './loaded-tools.ts'

const server: McpStdioServerConfig = {
  name: '中文 服务',
  scope: 'global',
  sourceFingerprint: 'a'.repeat(64),
  transport: 'stdio',
  command: 'node',
  args: [],
  cwd: process.cwd(),
  env: {},
  startupTimeoutMs: 10_000,
  toolTimeoutMs: 60_000,
}

describe('MCP 工具目录规范化', () => {
  it('生成跨 Provider 安全名称，并让 schema/config 变化改变描述符', () => {
    const first = buildServerCatalog(server, [{
      name: '查询 天气',
      description: '查询城市天气',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市' } },
        required: ['city'],
      },
      annotations: { readOnlyHint: true },
    }]).tools[0]!
    const second = buildServerCatalog(server, [{
      name: '查询 天气',
      description: '查询城市实时天气',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市' } },
        required: ['city'],
      },
    }]).tools[0]!

    assert.match(first.exposedName, /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u)
    assert.equal(first.inputSummary, 'city')
    assert.notEqual(first.descriptorHash, second.descriptorHash)
    assert.notEqual(first.exposedName, second.exposedName)

    const differentConnectionSecret = buildServerCatalog({
      ...server,
      sourceFingerprint: 'b'.repeat(64),
    }, [{
      name: '查询 天气',
      description: '查询城市天气',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string', description: '城市' } },
        required: ['city'],
      },
      annotations: { readOnlyHint: true },
    }]).tools[0]!
    assert.notEqual(first.descriptorHash, differentConnectionSecret.descriptorHash)
    assert.equal(first.exposedName, differentConnectionSecret.exposedName)

    const largeTools = buildServerCatalog(server, ['first', 'second', 'third'].map((name) => ({
      name,
      inputSchema: {
        type: 'object' as const,
        properties: {
          value: { type: 'string', description: name.repeat(20_000) },
        },
      },
    }))).tools
    const loaded = mergeLoadedMcpTools([largeTools[2]!], largeTools.slice(0, 2))
    assert.deepEqual(loaded.tools.map((tool) => tool.rawName), ['first', 'second'])
  })

  it('跳过重复名称、非对象 schema 和必须使用 Tasks 的工具', () => {
    const result = buildServerCatalog(server, [
      { name: 'ok', inputSchema: { type: 'object' } },
      { name: 'ok', inputSchema: { type: 'object' } },
      { name: 'bad-schema', inputSchema: { type: 'array' } as never },
      {
        name: 'bad-output',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'array' } as never,
      },
      {
        name: 'task-only',
        inputSchema: { type: 'object' },
        execution: { taskSupport: 'required' },
      },
    ])
    assert.deepEqual(result.tools.map((tool) => tool.rawName), ['ok'])
    assert.equal(result.diagnostics.length, 4)

    const bounded = buildServerCatalog(server, Array.from({ length: 12 }, (_, index) => ({
      name: `large-${index}`,
      inputSchema: {
        type: 'object' as const,
        description: 'x'.repeat(220_000),
      },
    })))
    assert.ok(bounded.tools.length < 12)
    assert.equal(bounded.diagnostics.some((message) => /工具目录超过/u.test(message)), true)
  })
})
