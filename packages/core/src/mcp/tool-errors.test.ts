import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TOOL_OUTCOME_UNKNOWN } from '../session/tool-execution.ts'
import type { McpFetch } from './connection-utils.ts'
import { McpServerConnection } from './server-connection.ts'

describe('MCP 工具失败结果', () => {
  it('服务端明确返回的失败内容保持原样', async (t) => {
    const expected = { isError: true, content: [{ type: 'text', text: '缺少必填字段：path' }] }
    const { connection, binding } = await connect((id) => rpc(id, { result: expected }))
    t.after(() => connection.close())
    assert.deepEqual(await connection.call(binding, {}, new AbortController().signal), expected)
  })

  it('明确的 RPC 错误不增加结果未知提示', async (t) => {
    const { connection, binding } = await connect((id) => rpc(id, {
      error: { code: -32602, message: '路径参数无效' },
    }))
    t.after(() => connection.close())
    await assert.rejects(connection.call(binding, {}, new AbortController().signal), (error: Error) => {
      assert.match(error.message, /路径参数无效/u)
      assert.ok(!error.message.includes(TOOL_OUTCOME_UNKNOWN))
      return true
    })
  })

  it('调用发出后连接断开，说明具体错误和无法确认执行结果', async (t) => {
    const { connection, binding } = await connect(() => { throw new Error('响应连接断开') })
    t.after(() => connection.close())
    await assert.rejects(connection.call(binding, {}, new AbortController().signal), (error: Error) => {
      assert.match(error.message, /响应连接断开/u)
      assert.ok(error.message.includes(TOOL_OUTCOME_UNKNOWN))
      return true
    })
  })

  it('调用前已取消不发送请求，也不推测产生了副作用', async (t) => {
    let calls = 0
    const { connection, binding } = await connect((id) => {
      calls++
      return rpc(id, { result: { content: [] } })
    })
    t.after(() => connection.close())
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(connection.call(binding, {}, controller.signal), (error: Error) => {
      assert.equal(error.name, 'AbortError')
      assert.ok(!error.message.includes(TOOL_OUTCOME_UNKNOWN))
      return true
    })
    assert.equal(calls, 0)
  })

  it('请求执行中取消，不能把客户端取消当作远端已停止的证明', async (t) => {
    const controller = new AbortController()
    const { connection, binding } = await connect((_id, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('响应已取消')), { once: true })
      controller.abort()
    }))
    t.after(() => connection.close())
    await assert.rejects(connection.call(binding, {}, controller.signal), (error: Error) => {
      assert.ok(error.message.includes(TOOL_OUTCOME_UNKNOWN))
      return true
    })
  })
})

async function connect(onCall: (id: unknown, signal?: AbortSignal | null) => Response | Promise<Response>) {
  const fetchImpl: McpFetch = async (_input, init) => {
    if (init?.method === 'GET') return new Response(null, { status: 405 })
    const request = JSON.parse(String(init?.body)) as { id?: unknown; method: string; params?: { protocolVersion?: string } }
    if (request.method.startsWith('notifications/')) return new Response(null, { status: 202 })
    if (request.method === 'initialize') return rpc(request.id, { result: {
      protocolVersion: request.params?.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'errors', version: '1.0.0' },
    } })
    if (request.method === 'tools/list') return rpc(request.id, { result: {
      tools: [{ name: 'write', description: 'Write test data', inputSchema: { type: 'object' } }],
    } })
    assert.equal(request.method, 'tools/call')
    return onCall(request.id, init?.signal)
  }
  const connection = new McpServerConnection({
    name: 'errors', scope: 'global', transport: 'http',
    sourceFingerprint: 'a'.repeat(64), runtimeFingerprint: 'b'.repeat(64),
    connectionFingerprint: 'c'.repeat(64), url: 'https://mcp.example.test/', headers: {},
    startupTimeoutMs: 2_000, toolTimeoutMs: 2_000,
  }, fetchImpl)
  await connection.prepare(new AbortController().signal)
  const binding = connection.bind(connection.availableTools()[0]!)
  assert.ok(binding)
  return { connection, binding }
}

function rpc(id: unknown, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, ...body }), {
    headers: { 'Content-Type': 'application/json' },
  })
}
