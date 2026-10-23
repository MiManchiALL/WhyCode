import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import type { Client, ClientChannel } from 'ssh2'
import type { McpFetch } from '@whycode/core'

/** DNS、localhost 和内网地址均由 SSH 服务器解析；TLS 仍校验原始主机。 */
export const sshFetch = async (
  client: Client, input: Parameters<McpFetch>[0], init?: RequestInit,
): Promise<Response> => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('MCP HTTP 地址无效')
  request.signal.throwIfAborted()
  const secure = url.protocol === 'https:'
  const hostname = url.hostname.replace(/^\[|\]$/gu, '')
  const agent = secure ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false })
  let channel: ClientChannel | undefined
  let closed = false
  const close = () => { closed = true; channel?.destroy(); agent.destroy() }
  agent.createConnection = (_options, callback) => {
    client.forwardOut('127.0.0.1', 0, hostname, Number(url.port || (secure ? 443 : 80)), (error, stream) => {
      if (error) { callback?.(error, null!); return }
      if (closed || request.signal.aborted) { stream.destroy(); return }
      channel = stream
      if (!secure) { callback?.(null, stream); return }
      const socket = tls.connect({ socket: stream, servername: isIP(hostname) ? undefined : hostname, host: hostname })
      const failed = (error: Error) => callback?.(error, null!)
      socket.once('error', failed)
      socket.once('secureConnect', () => { socket.off('error', failed); callback?.(null, socket) })
    })
    return undefined
  }
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined
  return new Promise<Response>((resolve, reject) => {
    const outgoing = (secure ? https : http).request(url, {
      agent, method: request.method, headers: Object.fromEntries(request.headers), signal: request.signal,
    }, response => {
      const status = response.statusCode ?? 502
      if (status >= 300 && status < 400 && status !== 304) {
        response.destroy(); close(); reject(new Error('远端 MCP HTTP 不允许重定向')); return
      }
      const headers = new Headers()
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!)
      }
      response.once('close', close)
      const empty = request.method === 'HEAD' || [204, 205, 304].includes(status)
      if (empty) response.resume()
      resolve(new Response(empty ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }))
    })
    outgoing.once('error', error => { close(); reject(error) })
    outgoing.end(body)
  })
}
