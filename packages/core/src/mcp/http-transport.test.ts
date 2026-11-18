import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { it } from 'node:test'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { McpServerConnection } from './server-connection.ts'

it('通过 SDK 的 Hono Node 适配器完成 loopback HTTP 握手、工具发现和调用', async () => {
  const server = new McpServer({ name: 'loopback', version: '1' })
  server.registerTool('echo', { inputSchema: { text: z.string() } }, ({ text }) => ({
    content: [{ type: 'text', text }],
  }))
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true })
  await server.connect(transport)
  const http = createServer((request, response) => { void transport.handleRequest(request, response) })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const address = http.address()
  assert.ok(address && typeof address !== 'string')
  const connection = new McpServerConnection({
    name: 'loopback', scope: 'global', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`,
    headers: {}, startupTimeoutMs: 10_000, toolTimeoutMs: 10_000,
    sourceFingerprint: 'a'.repeat(64), runtimeFingerprint: 'b'.repeat(64), connectionFingerprint: 'c'.repeat(64),
  }, fetch)
  try {
    const signal = AbortSignal.timeout(10_000)
    await connection.prepare(signal)
    assert.equal(connection.status().state, 'ready', connection.status().error)
    const [echo] = connection.availableTools()
    assert.ok(echo)
    assert.equal(echo.rawName, 'echo')
    const binding = connection.bind(echo)
    assert.ok(binding)
    assert.deepEqual(await connection.call(binding, { text: '工具回声' }, signal), {
      content: [{ type: 'text', text: '工具回声' }],
    })
  } finally {
    await connection.close()
    await server.close()
    http.closeAllConnections()
    await http[Symbol.asyncDispose]()
  }
})
