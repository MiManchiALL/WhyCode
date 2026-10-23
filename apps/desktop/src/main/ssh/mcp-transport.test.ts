import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { loadMcpConfiguration, McpSessionRuntime } from '@whycode/core'
import { sshFixture } from './ssh-test-fixture.ts'
import { remoteMcpEnvironment, remoteMcpTransport, SshMcpStdioTransport } from './mcp-transport.ts'
import { sshFetch } from './http.ts'
import { SshMcpProjects } from './mcp-projects.ts'

test('远端进程停止未确认时不报告传输关闭，保留重试能力', async () => {
  let stopped = false
  let closed = 0
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
    terminate: async () => stopped,
  })
  const transport = new SshMcpStdioTransport(() => process)
  transport.onclose = () => { closed++ }
  await transport.start()
  await assert.rejects(transport.close(), /未能确认/)
  assert.equal(closed, 0)
  stopped = true
  await transport.close()
  assert.equal(closed, 1)
  for (const stream of [process.stdin, process.stdout, process.stderr]) stream.destroy()
})

test('Streamable HTTP 经 SSH 转发解析远端地址并完成握手、SSE 与工具调用；取消关闭通道', { timeout: 30_000 }, async t => {
  const env = await sshFixture(t, 'protocol')
  await env.connections.connect(env.id, env.fingerprint)
  const host = env.connections.host(env.id)
  const destinations: string[] = []
  let cancelled!: () => void
  const wasCancelled = new Promise<void>(resolve => { cancelled = resolve })
  const server = createServer(async (request, response) => {
    if (request.url === '/redirect') { response.writeHead(302, { location: 'http://127.0.0.1/secret' }); response.end(); return }
    if (request.url === '/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write('data: start\n\n')
      response.on('close', cancelled); return
    }
    if (request.method === 'GET') { response.writeHead(405); response.end(); return }
    assert.equal(request.headers.authorization, 'Bearer fixture')
    let text = ''
    for await (const chunk of request) text += chunk.toString()
    const packet = JSON.parse(text)
    if (packet.id === undefined) { response.writeHead(202); response.end(); return }
    const result = packet.method === 'initialize'
      ? { protocolVersion: packet.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ssh-http', version: '1' } }
      : packet.method === 'tools/list'
        ? { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: `远端:${packet.params.arguments.text}` }] }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const bytes = Buffer.from(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: packet.id, result })}\n\n`)
    for (let index = 0; index < bytes.length; index += 5) response.write(bytes.subarray(index, index + 5))
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  for (const peer of env.clients) peer.on('tcpip', (accept, reject, info) => {
    destinations.push(info.destIP)
    if (info.destIP !== 'only-on-server.invalid') { reject(); return }
    const socket = connect(address.port, '127.0.0.1', () => {
      const stream = accept()
      stream.on('error', () => socket.destroy()); socket.on('error', () => stream.destroy())
      stream.on('close', () => socket.destroy()); socket.on('close', () => stream.destroy())
      socket.pipe(stream).pipe(socket)
    })
    socket.on('error', () => {})
  })
  const url = 'http://only-on-server.invalid/mcp'
  const client = new McpClient({ name: 'fixture', version: '1' })
  t.after(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    fetch: (input, init) => sshFetch(host.client, input, init), requestInit: { headers: { Authorization: 'Bearer fixture' } },
  }))
  assert.equal((await client.listTools()).tools[0]!.name, 'echo')
  const result = await client.callTool({ name: 'echo', arguments: { text: '你好🙂' } })
  assert.deepEqual(result.content, [{ type: 'text', text: '远端:你好🙂' }])
  assert.ok(destinations.length >= 3)
  await assert.rejects(sshFetch(host.client, 'http://only-on-server.invalid/redirect'), /不允许重定向/)
  const response = await sshFetch(host.client, 'http://only-on-server.invalid/stream')
  const reader = response.body!.getReader()
  await reader.read(); await reader.cancel(); await wasCancelled
})

test('真实 SSH stdio MCP 使用远端 cwd、环境和参数，关闭后进程退出且旧快照不能重启', {
  skip: process.env.WHYCODE_SSH_INTEGRATION !== '1', timeout: 90_000,
}, async t => {
  const env = await sshFixture(t, true)
  await env.connections.connect(env.id, env.fingerprint)
  const host = env.connections.host(env.id)
  const environment = await remoteMcpEnvironment(host.client, ['HOME', 'WHYCODE_MCP_TEST_MISSING'])
  assert.ok(environment.HOME?.startsWith('/'))
  assert.equal(environment.WHYCODE_MCP_TEST_MISSING, undefined)
  await writeFile(join(env.root, 'project/server.py'), `import sys, os, json
for line in sys.stdin:
    message = json.loads(line)
    if 'id' not in message: continue
    method = message.get('method')
    if method == 'initialize':
        result = {'protocolVersion': message['params']['protocolVersion'], 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'ssh-python', 'version': '1'}}
    elif method == 'tools/list':
        result = {'tools': [{'name': 'inspect', 'description': 'inspect remote process', 'inputSchema': {'type': 'object'}}]}
    else:
        result = {'content': [{'type': 'text', 'text': json.dumps({'pid': os.getpid(), 'cwd': os.getcwd(), 'env': os.environ['CUSTOM'], 'args': sys.argv[1:]})}]}
    print(json.dumps({'jsonrpc': '2.0', 'id': message['id'], 'result': result}), flush=True)
`)
  const service = new SshMcpProjects(env.connections, () => [env.project], async () => {})
  const document = await service.read(host.target, env.project)
  const special = "你好 ' quote; $(false)"
  await service.save({ ...document, text: JSON.stringify({ version: 1, servers: { remote: {
    transport: 'stdio', command: 'python3', args: ['server.py', special], env: { CUSTOM: special },
  } } }) })
  const workspace = { mode: 'ssh' as const, target: host.target, label: 'fixture', workingDirectory: env.project }
  const configuration = await loadMcpConfiguration({ globalConfigPath: join(env.root, 'global.json'), ...service.options(workspace) })
  const runtime = new McpSessionRuntime({ configuration, transportFactory: remoteMcpTransport(env.connections, host.target) })
  t.after(() => runtime.close())
  const manager = runtime.connectionManager()
  const signal = new AbortController().signal
  await manager.prepareAll(signal, false)
  assert.deepEqual(manager.snapshot(false).tools, [])
  runtime.trustProjectConfiguration()
  await manager.prepareAll(signal, true)
  const tools = manager.snapshot(true).tools
  assert.equal(tools.length, 1, JSON.stringify(manager.snapshot(true)))
  const { toolReference } = await import('../../../../../packages/core/src/mcp/catalog.ts')
  const bound = manager.bindReference(toolReference(tools[0]!), true)!
  const result = await manager.callTool(bound, {}, signal) as { content: { text: string }[] }
  const data = JSON.parse(result.content[0]!.text)
  assert.equal(data.cwd, env.project)
  assert.equal(data.env, special)
  assert.deepEqual(data.args, [special])
  await runtime.removeProjectServers()
  const check = host.processes.spawn(`kill -0 ${Number(data.pid)} 2>/dev/null`, env.project)
  check.stdout.resume(); check.stderr.resume()
  const [code] = await once(check, 'close')
  assert.notEqual(code, 0)
  await manager.prepareAll(signal, true)
  assert.deepEqual(manager.snapshot(true).tools, [])
})
