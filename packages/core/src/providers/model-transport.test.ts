import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { describe, it } from 'node:test'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText } from 'ai'
import { createModelFetch, MODEL_REQUEST_IDLE_TIMEOUT_MS } from './model-transport.ts'
import { ModelRequestError, readModelStream, withModelRequestRetry, type ModelRequestRetry } from './model-request.ts'

const encoder = new TextEncoder()
const event = (data: unknown) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`)

describe('模型网络请求生命周期', () => {
  for (const [protocol, createModel] of Object.entries({
    Responses: (fetch: typeof globalThis.fetch) => createOpenAI({ apiKey: 'test', fetch }).responses('test'),
    Chat: (fetch: typeof globalThis.fetch) => createOpenAICompatible({ name: 'test', baseURL: 'http://localhost', fetch })('test'),
    Messages: (fetch: typeof globalThis.fetch) => createAnthropic({ apiKey: 'test', fetch })('test'),
  })) {
    it(`${protocol} 实际 SDK 的错误页与代理错误共用简洁原因和三次重试预算`, async () => {
      let requests = 0
      const model = createModel(createModelFetch(async () => {
        const first = ++requests === 1
        const message = first ? '<!DOCTYPE html><html><head><style>body{margin:0}</style></head><body>Bad Gateway</body></html>'
          : JSON.stringify({ error: { message: 'auth_unavailable: no auth available (providers=proxy, model=test)' } })
        return new Response(message, { status: first ? 502 : 503, headers: {
          'content-type': first ? 'text/html' : 'application/json',
          'retry-after': '0', 'x-request-id': `request-${requests}`,
        } })
      }))
      const retries: ModelRequestRetry[] = []
      await assert.rejects(withModelRequestRetry(async () => {
        const result = streamText({ model, prompt: 'hello', maxRetries: 0, onError: () => {} })
        for await (const _part of readModelStream(result.fullStream)) { /* 消费真实 SDK 的错误块。 */ }
      }, new AbortController().signal, event => retries.push(event)), (error: unknown) => {
        assert.ok(error instanceof ModelRequestError)
        assert.equal(error.message,
          '上游服务暂无可用的认证凭据（auth_unavailable）（HTTP 503）；请求 ID：request-4；已重试 3 次，可稍后继续。')
        return true
      })
      assert.equal(requests, 4)
      assert.deepEqual(retries.map(event => [event.retry, event.maxRetries]), [[1, 3], [2, 3], [3, 3]])
      assert.equal(retries[0]?.message, '上游服务暂时异常（HTTP 502）；请求 ID：request-1')
      assert.equal(retries[1]?.message, '上游服务暂无可用的认证凭据（auth_unavailable）（HTTP 503）；请求 ID：request-2')
    })
  }

  it('Responses 在完成标记前直接断流，不能把已有正文当作成功交付', async () => {
    const parts = [
      { type: 'response.created', response: { id: 'r', created_at: 1, model: 'test' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'm', type: 'message' } },
      { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: '未完成' },
    ]
    const model = createOpenAI({ apiKey: 'test', fetch: createModelFetch(async () => new Response(
      new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(event(part)); controller.close() } }),
      { headers: { 'content-type': 'text/event-stream' } },
    )) }).responses('test')
    const result = streamText({ model, prompt: 'hello', maxRetries: 0, onError: () => {} })
    await assert.rejects(async () => {
      for await (const _part of readModelStream(result.fullStream)) { /* 验证真实 SDK 的终止语义。 */ }
    }, /模型响应未正常结束/)
  })

  it('Responses 只有心跳与元数据时保持连接，完整正文随后正常返回', async (t) => {
    assert.equal(MODEL_REQUEST_IDLE_TIMEOUT_MS, 300_000)
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    let source!: ReadableStreamDefaultController<Uint8Array>
    let signal!: AbortSignal
    const fetchRequest: typeof fetch = async (_input, init) => {
      signal = init!.signal!
      return new Response(new ReadableStream({
        start(controller) {
          source = controller
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        },
      }), { headers: { 'content-type': 'text/event-stream' } })
    }
    const model = createOpenAI({ apiKey: 'test', fetch: createModelFetch(fetchRequest, 100) }).responses('test')
    const result = streamText({ model, prompt: 'hello', maxRetries: 0 })
    const parts: string[] = []
    const reading = (async () => {
      for await (const part of readModelStream(result.fullStream)) parts.push(part.type)
    })()
    await setImmediate()
    source.enqueue(event({ type: 'response.created', response: { id: 'test-response', created_at: 1, model: 'test' } }))
    await setImmediate()
    for (let index = 0; index < 5; index++) {
      t.mock.timers.tick(80)
      source.enqueue(encoder.encode(': keepalive\n\n'))
      await setImmediate()
    }
    assert.equal(signal.aborted, false)
    assert.equal(parts.includes('text-delta'), false)
    source.enqueue(event({ type: 'response.output_item.added', output_index: 0, item: { id: 'message', type: 'message' } }))
    source.enqueue(event({ type: 'response.output_text.delta', item_id: 'message', output_index: 0, content_index: 0, delta: '完成' }))
    source.enqueue(event({ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } }))
    source.close()
    await reading
    assert.equal(await result.text, '完成')
    assert.equal(parts.includes('finish'), true)
  })

  it('真正停止返回字节时取消请求，保留响应阶段和请求标识', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    let signal!: AbortSignal
    const fetchRequest: typeof fetch = async (_input, init) => {
      signal = init!.signal!
      return new Response(new ReadableStream({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
        },
      }), { headers: { 'x-request-id': 'request-idle' } })
    }
    const parent = new AbortController()
    const response = await createModelFetch(fetchRequest, 100)('http://localhost/model', { signal: parent.signal })
    const reading = response.text()
    const rejected = assert.rejects(reading, (error: unknown) => {
      assert.ok(error instanceof ModelRequestError)
      assert.equal(error.retryable, true)
      assert.match(error.message, /读取响应数据.*request-idle/)
      return true
    })
    await setImmediate()
    t.mock.timers.tick(101)
    await rejected
    assert.equal(signal.aborted, true)
    assert.equal(parent.signal.aborted, false)
  })

  it('服务器尚未建立响应也有等待上限', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const fetchRequest: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
    })
    const pending = createModelFetch(fetchRequest, 100)('http://localhost/model')
    const rejected = assert.rejects(pending, /等待服务器响应/)
    t.mock.timers.tick(101)
    await rejected
  })

  it('消费者处理和完成后的本地工作不计时；下一次读取仍正常', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    let signal!: AbortSignal
    const fetchRequest: typeof fetch = async (_input, init) => {
      signal = init!.signal!
      return new Response('body')
    }
    const response = await createModelFetch(fetchRequest, 100)('http://localhost/model')
    t.mock.timers.tick(1_000)
    assert.equal(signal.aborted, false)
    const reader = response.body!.getReader()
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'body')
    t.mock.timers.tick(1_000)
    assert.equal(signal.aborted, false)
    assert.equal((await reader.read()).done, true)
    t.mock.timers.tick(1_000)
    assert.equal(signal.aborted, false)
  })

  it('用户取消传到实际网络，并释放等待计时', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const parent = new AbortController()
    let signal!: AbortSignal
    const fetchRequest: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      signal = init!.signal!
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    const pending = createModelFetch(fetchRequest, 100)('http://localhost/model', { signal: parent.signal })
    const rejected = assert.rejects(pending, (error: unknown) => error === 'user-cancel')
    parent.abort('user-cancel')
    await rejected
    t.mock.timers.tick(1_000)
    assert.equal(signal.reason, 'user-cancel')
  })
})
