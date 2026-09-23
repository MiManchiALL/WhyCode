import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { APICallError, simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import type { CoreEvent } from '../events.ts'
import { getModelEntry } from '../providers/registry.ts'
import { buildTool } from '../tools/tool.ts'
import { AgentSession } from './session.ts'

describe('模型失败后的步骤恢复', () => {
  it('重试与最终失败发出同一简洁原因，不把错误页写入模型上下文', async () => {
    const model = new MockLanguageModelV4({ doStream: async () => {
      throw new APICallError({
        message: '<!DOCTYPE html><html><body>Bad Gateway</body></html>', statusCode: 502,
        url: 'http://localhost/model', requestBodyValues: {}, responseHeaders: { 'retry-after': '0' },
      })
    } })
    const events: CoreEvent[] = []
    const session = createSession(model, event => events.push(event))
    assert.equal(await session.handleUserMessage('回答'), 'error')
    assert.equal(model.doStreamCalls.length, 4)
    assert.deepEqual(events.filter(event => event.type === 'model-request-retry').map(event => event.message),
      Array(3).fill('上游服务暂时异常（HTTP 502）'))
    assert.equal(events.find(event => event.type === 'error')?.message,
      '上游服务暂时异常（HTTP 502）；已重试 3 次，可稍后继续。')
    assert.doesNotMatch(JSON.stringify(session.captureMessageSnapshot()), /DOCTYPE|Bad Gateway|HTTP 502/)
  })

  it('流中途失败只重发当前请求，已执行工具不重放、半截工具不执行', async () => {
    let requests = 0
    let writes = 0
    const model = new MockLanguageModelV4({ doStream: async () => {
      requests++
      if (requests === 1) return { stream: simulateReadableStream({ chunks: [
        { type: 'tool-call', toolCallId: 'committed', toolName: 'WriteProbe', input: '{}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
      ] }) }
      if (requests === 2) return { stream: simulateReadableStream({ chunks: [
        { type: 'text-start', id: 'draft' },
        { type: 'text-delta', id: 'draft', delta: '不完整的草稿' },
        { type: 'tool-call', toolCallId: 'uncommitted', toolName: 'WriteProbe', input: '{}' },
        { type: 'error', error: transientError() },
      ] }) }
      return finalStep()
    } })
    const events: CoreEvent[] = []
    const session = createSession(model, event => events.push(event))
    session.setPermissionMode('auto')
    session.setExtraTools([buildTool({
      name: 'WriteProbe', description: '记录副作用', prompt: '测试', inputSchema: z.object({}),
      kind: 'edit', isReadOnly: false,
      async execute() { writes++; return { data: '文件已写入', isError: false } },
    })])
    assert.equal(await session.handleUserMessage('先修改再回答'), 'completed')
    assert.equal(requests, 3)
    assert.equal(writes, 1)
    assert.deepEqual(model.doStreamCalls[2]!.prompt, model.doStreamCalls[1]!.prompt)
    assert.match(JSON.stringify(model.doStreamCalls[2]!.prompt), /文件已写入/)
    assert.doesNotMatch(JSON.stringify(session.captureMessageSnapshot()), /不完整的草稿|uncommitted|模型请求重试/)
    assert.equal(events.filter(event => event.type === 'tool-end').length, 1)
    assert.equal(events.filter(event => event.type === 'model-request-retry').length, 1)
  })

  for (const mode of ['stop', 'urgent'] as const) {
    it(`${mode} 取消重试等待，继续时使用最新输入与已有历史`, async () => {
      let requests = 0
      const model = new MockLanguageModelV4({ doStream: async () => {
        if (++requests === 1) throw transientError()
        return finalStep()
      } })
      const session = createSession(model, event => {
        if (event.type !== 'model-request-retry') return
        if (mode === 'stop') session.abort()
        else session.handleUserMessage('改为解释已有结果', true)
      })
      assert.equal(await session.handleUserMessage('开始'), mode === 'stop' ? 'aborted' : 'completed')
      if (mode === 'stop') {
        assert.equal(requests, 1)
        assert.equal(await session.handleUserMessage('继续'), 'completed')
      }
      assert.equal(requests, 2)
      assert.match(JSON.stringify(model.doStreamCalls[1]!.prompt), mode === 'stop' ? /继续/ : /改为解释已有结果/)
    })
  }

  it('空答复与 HTTP 错误使用同一预算，SDK 不额外重试', async () => {
    let requests = 0
    const retries: number[] = []
    const model = new MockLanguageModelV4({ doStream: async () => {
      requests++
      if (requests === 2) throw transientError()
      return { stream: simulateReadableStream({ chunks: [
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ] }) }
    } })
    const session = createSession(model, event => {
      if (event.type === 'model-request-retry') retries.push(event.retry)
    })
    assert.equal(await session.handleUserMessage('回答'), 'error')
    assert.equal(requests, 4)
    assert.deepEqual(retries, [1, 2, 3])
  })
})

function createSession(model: MockLanguageModelV4, emit: (event: CoreEvent) => void): AgentSession {
  return new AgentSession({
    model: { ...getModelEntry('openai:gpt-5.6-sol'), create: () => model },
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
    emit, requestApproval: async () => ({ approved: true }),
  })
}

function transientError(): APICallError {
  return new APICallError({
    message: '服务器暂时不可用', statusCode: 503,
    url: 'http://localhost/model', requestBodyValues: {},
  })
}

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

function finalStep() {
  return { stream: simulateReadableStream({ chunks: [
    { type: 'text-start' as const, id: 'answer' },
    { type: 'text-delta' as const, id: 'answer', delta: '已根据已有结果完成。' },
    { type: 'text-end' as const, id: 'answer' },
    { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
  ] }) }
}
