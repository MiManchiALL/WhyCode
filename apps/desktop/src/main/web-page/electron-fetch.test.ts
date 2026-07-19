import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'
import type {
  ClientRequest,
  ClientRequestConstructorOptions,
  IncomingMessage,
} from 'electron'
import {
  createElectronWebHostResolver,
  createElectronWebPageFetch,
} from './electron-fetch.ts'

class FakeRequest extends EventEmitter {
  abortCalls = 0
  readonly onEnd: (request: FakeRequest) => void

  constructor(onEnd: (request: FakeRequest) => void) {
    super()
    this.onEnd = onEnd
  }

  end(): this {
    this.onEnd(this)
    return this
  }

  abort(): void {
    this.abortCalls++
    this.emit('abort')
    this.emit('close')
  }
}

class FakeIncomingMessage extends EventEmitter {
  headers: Record<string, string | string[]> = { 'content-type': 'text/plain' }
  statusCode = 200
  statusMessage = 'OK'
}

describe('Electron net.request Fetch 适配器', () => {
  it('同时解析并合并公开域名的 A 与 AAAA 端点', async () => {
    const queryTypes: string[] = []
    const resolveHost = createElectronWebHostResolver(async (_hostname, options) => {
      queryTypes.push(options.queryType ?? '')
      return {
        endpoints: options.queryType === 'A'
          ? [{ address: '93.184.216.34', family: 'ipv4' }]
          : [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 'ipv6' }],
      }
    })

    const result = await resolveHost('example.com')
    assert.deepEqual(queryTypes.sort(), ['A', 'AAAA'])
    assert.deepEqual(result.endpoints.map((endpoint) => endpoint.address), [
      '93.184.216.34',
      '2606:2800:220:1:248:1893:25c8:1946',
    ])
  })

  it('把 manual redirect 事件转换为可逐跳校验的 Response', async () => {
    let capturedOptions: ClientRequestConstructorOptions | undefined
    const fetchImpl = createElectronWebPageFetch((options) => {
      capturedOptions = options
      return new FakeRequest((request) => {
        request.emit('redirect', 302, 'GET', 'https://example.com/final', {
          location: ['https://example.com/final'],
        })
        queueMicrotask(() => {
          request.emit('error', new Error('Redirect was cancelled'))
          request.emit('close')
        })
      }) as unknown as ClientRequest
    })

    const response = await fetchImpl('https://example.com/start', {
      method: 'GET',
      headers: { accept: 'text/html' },
      credentials: 'omit',
      redirect: 'manual',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      bypassCustomProtocolHandlers: true,
    })

    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), 'https://example.com/final')
    assert.equal(capturedOptions?.redirect, 'manual')
    assert.equal(capturedOptions?.credentials, 'omit')
    assert.equal(capturedOptions?.useSessionCookies, false)
    assert.equal(capturedOptions?.bypassCustomProtocolHandlers, true)
  })

  it('把 IncomingMessage 增量转换为可取消的 Response body', async () => {
    const incoming = new FakeIncomingMessage()
    let request: FakeRequest | undefined
    const fetchImpl = createElectronWebPageFetch(() => {
      request = new FakeRequest((value) => {
        value.emit('response', incoming as unknown as IncomingMessage)
        queueMicrotask(() => {
          incoming.emit('data', Buffer.from('hello '))
          incoming.emit('data', Buffer.from('world'))
          incoming.emit('end')
          value.emit('close')
        })
      })
      return request as unknown as ClientRequest
    })

    const response = await fetchImpl('https://example.com/', {
      method: 'GET',
      signal: new AbortController().signal,
    })
    assert.equal(await response.text(), 'hello world')
    assert.equal(response.headers.get('content-type'), 'text/plain')
    assert.equal(request?.abortCalls, 0)
    assert.doesNotThrow(() => request?.emit('error', new Error('late transport close')))
  })

  it('读取响应期间取消会中止底层 ClientRequest', async () => {
    const incoming = new FakeIncomingMessage()
    const controller = new AbortController()
    let request: FakeRequest | undefined
    const fetchImpl = createElectronWebPageFetch(() => {
      request = new FakeRequest((value) => {
        value.emit('response', incoming as unknown as IncomingMessage)
      })
      return request as unknown as ClientRequest
    })

    const response = await fetchImpl('https://example.com/', {
      method: 'GET',
      signal: controller.signal,
    })
    const read = response.body!.getReader().read()
    controller.abort()
    await assert.rejects(read, /aborted|取消|中断/iu)
    assert.equal(request?.abortCalls, 1)
  })
})
