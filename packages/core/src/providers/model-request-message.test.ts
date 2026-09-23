import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { APICallError } from 'ai'
import { modelRequestError } from './model-request.ts'

const html = '<!DOCTYPE html><html><head><title>Error 502</title><style>body{margin:0}</style></head>'
  + '<body><h1>Bad Gateway</h1><script>debug()</script></body></html>'

describe('模型请求失败原因', () => {
  it('HTML 错误页和 JSON 内嵌错误页均归一为简短原因，保留状态与请求 ID', () => {
    for (const message of [html, JSON.stringify({ error: { message: html } })]) {
      const raw = apiError({ message, statusCode: 502, responseHeaders: { 'x-request-id': 'request-502' } })
      const error = modelRequestError(raw)
      assert.equal(error.message, '上游服务暂时异常（HTTP 502）；请求 ID：request-502')
      assert.equal(error.retryable, true)
      assert.equal(error.cause, raw)
    }
    assert.equal(modelRequestError(new Error(html)).message, '模型服务返回了异常响应')
  })

  it('从错误字段提取实际原因，不展开 JSON 中的请求或调试信息', () => {
    const response = { error: { message: '参数 temperature 必须在 0 到 2 之间', code: 'invalid_parameter' }, debug: '不展示' }
    for (const extra of [{ data: response }, { responseBody: JSON.stringify(response) }]) {
      const error = modelRequestError(apiError({ message: 'Bad Request', statusCode: 400, ...extra }))
      assert.equal(error.message, 'invalid_parameter: 参数 temperature 必须在 0 到 2 之间（HTTP 400）')
      assert.equal(error.retryable, false)
    }
    const nested = { error: { error: { message: '模型不支持图片输入' }, type: 'invalid_request_error' } }
    assert.equal(modelRequestError(apiError({ message: JSON.stringify(nested), statusCode: 400 })).message,
      'invalid_request_error: 模型不支持图片输入（HTTP 400）')
    const opaque = { error: { code: 'upstream_error', message: '{"debug":"internal"}' } }
    assert.equal(modelRequestError(apiError({ message: JSON.stringify(opaque), statusCode: 502 })).message,
      'upstream_error（HTTP 502）')
  })

  it('代理无可用凭据与用户鉴权错误分别呈现，保持 HTTP 重试语义', () => {
    const error = modelRequestError(apiError({
      message: 'auth_unavailable: no auth available (providers=proxy, model=test)', statusCode: 503,
    }))
    assert.equal(error.message, '上游服务暂无可用的认证凭据（auth_unavailable）（HTTP 503）')
    assert.equal(error.retryable, true)
    const unauthorized = modelRequestError(apiError({ message: 'Invalid API key', statusCode: 401 }))
    assert.equal(unauthorized.message, 'Invalid API key（HTTP 401）')
    assert.equal(unauthorized.retryable, false)
  })

  it('重试分类使用未截短的错误字段，额度不足不因展示处理而重试', () => {
    for (const error of [
      apiError({ message: 'Too Many Requests', statusCode: 429,
        responseBody: JSON.stringify({ error: { message: 'Account limit reached', code: 'insufficient_quota' } }) }),
      apiError({ message: `${'详情 '.repeat(150)}insufficient_balance`, statusCode: 503 }),
    ]) {
      assert.equal(modelRequestError(error).retryable, false)
    }
  })

  it('正常文本压缩空白并限制长度，请求标识不被长原因挤掉', () => {
    const error = modelRequestError(apiError({
      message: `服务繁忙\n\t ${'详细说明 '.repeat(100)}`, statusCode: 503,
      responseHeaders: { 'request-id': 'request-long' },
    }))
    assert.match(error.message, /^服务繁忙 详细说明/)
    assert.match(error.message, /…（HTTP 503）；请求 ID：request-long$/)
    assert.ok(error.message.length < 300)
    assert.doesNotMatch(error.message, /[\r\n\t]/)
    assert.equal(modelRequestError(apiError({ message: '[invalid_parameter] temperature must be <= 2', statusCode: 400 })).message,
      '[invalid_parameter] temperature must be <= 2（HTTP 400）')
  })

  it('空响应、不可提取的 JSON 和 HTML 片段使用实际状态说明', () => {
    for (const message of ['', '{"debug":"internal"}', '<h1>Gateway Timeout</h1>']) {
      const error = modelRequestError(apiError({ message, statusCode: 504 }))
      assert.equal(error.message, '上游服务响应超时（HTTP 504）')
      assert.equal(error.retryable, true)
    }
    assert.equal(modelRequestError({ error: { message: 'stream unavailable' } }).message, 'stream unavailable')
  })
})

function apiError(options: Partial<ConstructorParameters<typeof APICallError>[0]>): APICallError {
  return new APICallError({ message: 'request failed', url: 'http://localhost/model', requestBodyValues: {}, ...options })
}
