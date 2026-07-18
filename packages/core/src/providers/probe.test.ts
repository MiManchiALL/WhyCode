import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MockLanguageModelV4 } from 'ai/test'
import { probeCustomConnection } from './probe.ts'

describe('自定义连接能力探测', () => {
  it('只有可验证结果才开放文本、工具和图片能力', async () => {
    let call = 0
    const providerOptions = { mimo: { thinking: { type: 'enabled' } } }
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++
        if (call === 1) return response([{ type: 'text', text: 'text-ok' }])
        if (call === 2) {
          return response([{
            type: 'tool-call',
            toolCallId: 'probe-call',
            toolName: 'whycode_capability_probe',
            input: JSON.stringify({ nonce: 'tool-nonce' }),
          }])
        }
        return response([{ type: 'text', text: '4931' }])
      },
    })

    const report = await probeCustomConnection(model, {
      nonceFactory: sequence(['text-nonce', 'tool-nonce']),
      visualChallengeFactory: async () => ({
        expected: '4931',
        png: Buffer.from('test-image'),
      }),
      providerOptions,
    })

    assert.equal(report.text.state, 'supported')
    assert.equal(report.tools.state, 'supported')
    assert.equal(report.image.state, 'supported')
    assert.equal(model.doGenerateCalls.length, 3)
    for (const request of model.doGenerateCalls) {
      assert.deepEqual(request.providerOptions, providerOptions)
    }
  })

  it('文本失败后不继续发送能力探测请求', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('network unavailable')
      },
    })
    const report = await probeCustomConnection(model)
    assert.equal(report.text.state, 'unknown')
    assert.equal(report.tools.state, 'unknown')
    assert.equal(report.image.state, 'unknown')
    assert.equal(model.doGenerateCalls.length, 1)
  })

  it('含糊的工具或图片回复不会误报支持', async () => {
    let call = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        call++
        return response([{ type: 'text', text: call === 1 ? 'ok' : 'I cannot verify that.' }])
      },
    })
    const report = await probeCustomConnection(model, {
      nonceFactory: sequence(['text', 'tool']),
      visualChallengeFactory: async () => ({ expected: '4931', png: Buffer.from('image') }),
    })
    assert.equal(report.tools.state, 'unknown')
    assert.equal(report.image.state, 'unknown')
  })

  it('不会把认证、限流或网络问题误判成能力不支持', async () => {
    for (const statusCode of [401, 403, 408, 429, 500]) {
      const error = Object.assign(new Error(`status ${statusCode}`), { statusCode })
      const model = new MockLanguageModelV4({ doGenerate: async () => { throw error } })
      const report = await probeCustomConnection(model)
      assert.equal(report.text.state, 'unknown')
    }
  })

  it('明确拒绝请求格式时标记为不支持', async () => {
    const error = Object.assign(new Error('unsupported payload'), { statusCode: 415 })
    const model = new MockLanguageModelV4({ doGenerate: async () => { throw error } })
    const report = await probeCustomConnection(model)
    assert.equal(report.text.state, 'unsupported')
  })
})

function response(content: Array<
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
>) {
  return {
    content,
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  }
}

function sequence(values: string[]): () => string {
  let index = 0
  return () => values[index++] ?? 'fallback'
}
