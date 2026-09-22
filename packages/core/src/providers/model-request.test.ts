import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { APICallError } from 'ai'
import { emptyModelResponse, ModelRequestError, modelRequestError, withModelRequestRetry } from './model-request.ts'

describe('模型请求统一重试', () => {
  it('空答复和网络失败共用两次预算，保留最后一次失败原因', async () => {
    let calls = 0
    const retries: number[] = []
    const failures = [emptyModelResponse('stop'), new ModelRequestError('连接断开', true, 0), emptyModelResponse('stop')]
    await assert.rejects(withModelRequestRetry(async () => {
      throw failures[calls++]
    }, new AbortController().signal, (event) => retries.push(event.retry)), /模型没有返回可交付答复.*已重试 2 次/)
    assert.equal(calls, 3)
    assert.deepEqual(retries, [1, 2])
  })

  it('鉴权、余额、参数错误和本地异常不重试；限流和临时服务器错误可重试', async () => {
    for (const [statusCode, message, expected] of [
      [401, 'unauthorized', false], [402, 'Insufficient Balance', false],
      [429, 'insufficient_quota', false], [400, 'invalid request', false],
      [429, 'too many requests', true], [503, 'temporarily unavailable', true],
    ] as const) {
      const error = modelRequestError(new APICallError({
        message, url: 'http://localhost/model', requestBodyValues: {}, statusCode,
        responseHeaders: { 'retry-after': '0', 'x-request-id': 'test-request' },
      }))
      assert.equal(error.retryable, expected, `${statusCode}: ${message}`)
      assert.match(error.message, /test-request/)
      let calls = 0
      try { await withModelRequestRetry(async () => { calls++; throw error }, new AbortController().signal) } catch {}
      assert.equal(calls, expected ? 3 : 1)
    }
    let localCalls = 0
    await assert.rejects(withModelRequestRetry(async () => {
      localCalls++
      throw new Error('文件写入失败')
    }, new AbortController().signal), /文件写入失败/)
    assert.equal(localCalls, 1)
  })

  it('用户停止或插队取消退避等待，不发送下一次请求', async () => {
    for (const reason of ['user-cancel', 'interrupt']) {
      const controller = new AbortController()
      let calls = 0
      await assert.rejects(withModelRequestRetry(async () => {
        calls++
        throw new ModelRequestError('读取超时', true)
      }, controller.signal, () => controller.abort(reason)), { name: 'AbortError' })
      assert.equal(calls, 1)
    }
  })

  it('SDK 包装后的传输超时保留分类；过长的 Retry-After 交给用户决定', async () => {
    const timeout = new ModelRequestError('读取响应数据超时', true)
    assert.equal(modelRequestError(new Error('provider failed', { cause: timeout })), timeout)
    let calls = 0
    await assert.rejects(withModelRequestRetry(async () => {
      calls++
      throw new ModelRequestError('稍后重试', true, 60_000)
    }, new AbortController().signal), /稍后重试/)
    assert.equal(calls, 1)
  })
})
