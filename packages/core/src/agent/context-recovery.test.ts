import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { APICallError, simulateReadableStream, type ModelMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import { TOOL_RESULT_PRUNED } from '../context/microcompact.ts'
import type { CoreEvent } from '../events.ts'
import { getModelEntry } from '../providers/registry.ts'
import { buildTool } from '../tools/tool.ts'
import { AgentSession } from './session.ts'

describe('上下文超限的有限恢复', () => {
  it('完整请求低于估算阈值但被供应商拒绝时，压缩后重试且不重放工具', async (t) => {
    let requests = 0
    let writes = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => summary(),
      doStream: async () => {
        requests++
        if (requests === 1) return { stream: simulateReadableStream({ chunks: [
          { type: 'tool-call', toolCallId: 'saved', toolName: 'WriteProbe', input: '{}' },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
        ] }) }
        if (requests === 2) return { stream: simulateReadableStream({ chunks: [
          { type: 'text-start', id: 'draft' },
          { type: 'text-delta', id: 'draft', delta: '未完成草稿' },
          { type: 'tool-call', toolCallId: 'incomplete', toolName: 'WriteProbe', input: '{}' },
          { type: 'error', error: overflow() },
        ] }) }
        return finalStep()
      },
    })
    const { session, events } = fixture(model)
    t.after(() => session.dispose())
    session.setPermissionMode('auto')
    session.setExtraTools([buildTool({
      name: 'WriteProbe', description: '写入探针', prompt: '测试', inputSchema: z.object({}),
      kind: 'edit', isReadOnly: false,
      execute: async () => { writes++; return { data: '已写入结果', isError: false } },
    })])
    assert.equal(await session.handleUserMessage('先修改再回答'), 'completed')
    assert.equal(requests, 3)
    assert.equal(writes, 1)
    assert.equal(model.doGenerateCalls.length, 1)
    assert.match(JSON.stringify(model.doStreamCalls[2]!.prompt), /已写入结果/)
    assert.doesNotMatch(JSON.stringify(model.doStreamCalls[2]!.prompt), /未完成草稿|incomplete/)
    assert.equal(events.filter(event => event.type === 'step-discarded').length, 1)
    assert.equal(events.filter(event => event.type === 'model-request-retry').length, 1)
    const compacted = events.find(event => event.type === 'context-compacted')
    assert.ok(compacted?.type === 'context-compacted' && compacted.postTokens < compacted.preTokens)
  })

  it('旧工具输出微清理已缩小请求时直接恢复，无需调用摘要模型', async (t) => {
    let requests = 0
    const model = new MockLanguageModelV4({ doStream: async () => {
      if (++requests === 1) throw overflow()
      return finalStep()
    } })
    const { session, events } = fixture(model)
    t.after(() => session.dispose())
    const messages: ModelMessage[] = [{ role: 'user', content: '逐个检查文件' }]
    for (let index = 0; index < 6; index++) {
      const toolCallId = `read-${index}`
      messages.push({ role: 'assistant', content: [{ type: 'tool-call', toolCallId,
        toolName: 'ReadFile', input: { path: `${index}.txt` } }] })
      messages.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId,
        toolName: 'ReadFile', output: { type: 'text', value: index === 0 ? 'x'.repeat(20_000) : '内容' } }] })
    }
    session.restoreMessageSnapshot(messages)
    assert.equal(await session.handleUserMessage('继续'), 'completed')
    assert.equal(requests, 2)
    assert.equal(model.doGenerateCalls.length, 0)
    assert.ok(JSON.stringify(model.doStreamCalls[1]!.prompt).includes(TOOL_RESULT_PRUNED.trim()))
    assert.deepEqual(events.filter(event => event.type === 'context-compacted').map(event => event.level), ['micro'])
  })

  it('主请求和摘要先后超限时分别计数，摘要尾部原样进入恢复请求', async t => {
    let summaries = 0
    let requests = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        if (++summaries === 1) throw new APICallError({
          message: 'prompt is too long: 128100 tokens > 128000 maximum',
          statusCode: 400, url: 'http://localhost/model', requestBodyValues: {},
        })
        return summary('已完成最早任务')
      },
      doStream: async () => {
        if (++requests === 1) throw overflow()
        return finalStep()
      },
    })
    const { session, events } = fixture(model)
    t.after(() => session.dispose())
    assert.equal(await session.handleUserMessage('继续'), 'completed')
    assert.equal(requests, 2)
    assert.equal(summaries, 2)
    const retrySummary = JSON.stringify(model.doGenerateCalls[1]!.prompt)
    assert.match(retrySummary, /旧任务 0/)
    assert.doesNotMatch(retrySummary, /旧任务 1|旧任务 2/)
    const resumed = JSON.stringify(model.doStreamCalls[1]!.prompt)
    assert.match(resumed, /已完成最早任务/)
    assert.ok(resumed.includes(`旧任务 1：${'x'.repeat(64_000)}`))
    assert.ok(resumed.includes(`旧任务 2：${'x'.repeat(64_000)}`))
    assert.deepEqual(events.filter(event => event.type === 'model-request-retry')
      .map(event => [event.retry, event.maxRetries]), [[1, 3], [1, 1]])
    const compacted = events.find(event => event.type === 'context-compacted')
    assert.ok(compacted?.type === 'context-compacted' && compacted.postTokens < compacted.preTokens)
  })

  it('恢复后的请求仍然超限时停止，同一步不再次压缩', async (t) => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => summary(), doStream: async () => { throw overflow() },
    })
    const { session, events } = fixture(model)
    t.after(() => session.dispose())
    assert.equal(await session.handleUserMessage('继续'), 'error')
    assert.equal(model.doStreamCalls.length, 2)
    assert.equal(model.doGenerateCalls.length, 1)
    assert.equal(events.filter(event => event.type === 'model-request-retry').length, 1)
  })

  for (const outcome of ['no-history', 'failed-summary', 'larger-summary'] as const) {
    it(`${outcome} 没有实际缩小请求时不重试，并给出原因`, async (t) => {
      const model = new MockLanguageModelV4({
        doGenerate: async () => {
          if (outcome === 'failed-summary') throw new Error('摘要服务失败')
          return summary('摘要'.repeat(120_000))
        },
        doStream: async () => { throw overflow() },
      })
      const { session, events } = fixture(model)
      t.after(() => session.dispose())
      if (outcome === 'no-history') session.restoreMessageSnapshot([])
      assert.equal(await session.handleUserMessage('继续'), 'error')
      assert.equal(model.doStreamCalls.length, 1)
      assert.equal(model.doGenerateCalls.length, outcome === 'no-history' ? 0 : 1)
      assert.equal(events.some(event => event.type === 'model-request-retry'), false)
      assert.equal(events.some(event => event.type === 'context-compacted'), false)
      assert.match(events.findLast(event => event.type === 'error')?.message ?? '', outcome === 'larger-summary'
        ? /压缩后的原始用户输入、保留尾部与必要上下文仍无法缩小请求/ : /未能缩小请求/)
    })
  }

  it('压缩恢复不重置同一步的临时网络错误预算', async (t) => {
    let requests = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => summary(),
      doStream: async () => {
        if (++requests === 2) throw overflow()
        throw new APICallError({
          message: '服务暂时不可用', statusCode: 503, url: 'http://localhost/model',
          requestBodyValues: {}, responseHeaders: { 'retry-after': '0' },
        })
      },
    })
    const { session, events } = fixture(model)
    t.after(() => session.dispose())
    assert.equal(await session.handleUserMessage('继续'), 'error')
    assert.equal(requests, 5, '三次网络重试与一次压缩恢复分别有界')
    assert.equal(model.doGenerateCalls.length, 1)
    assert.deepEqual(events.filter(event => event.type === 'model-request-retry')
      .map(event => [event.retry, event.maxRetries]), [[1, 3], [1, 1], [2, 3], [3, 3]])
  })

  for (const boundary of ['summary', 'retry'] as const) {
    for (const action of ['stop', 'urgent'] as const) {
      it(`${boundary} 期间 ${action} 会取消旧请求恢复`, async (t) => {
        let requests = 0
        let interrupted = false
        const interrupt = () => {
          if (interrupted) return
          interrupted = true
          if (action === 'stop') session.abort()
          else session.handleUserMessage('改为新的要求', true)
        }
        const model = new MockLanguageModelV4({
          doGenerate: async () => {
            if (boundary === 'summary') interrupt()
            return summary()
          },
          doStream: async () => {
            if (++requests === 1) throw overflow()
            return finalStep()
          },
        })
        const { session } = fixture(model, event => {
          if (boundary === 'retry' && event.type === 'model-request-retry') interrupt()
        })
        t.after(() => session.dispose())
        assert.equal(await session.handleUserMessage('继续'), action === 'stop' ? 'aborted' : 'completed')
        assert.equal(requests, action === 'stop' ? 1 : 2)
        if (action === 'urgent') assert.match(JSON.stringify(model.doStreamCalls[1]!.prompt), /改为新的要求/)
      })
    }
  }
})

function fixture(model: MockLanguageModelV4, onEvent?: (event: CoreEvent) => void) {
  const events: CoreEvent[] = []
  const session = new AgentSession({
    model: { ...getModelEntry('openai:gpt-5.6-sol'),
      capabilities: { ...getModelEntry('openai:gpt-5.6-sol').capabilities, contextWindow: 128_000, maxOutput: 20_000 },
      create: () => model },
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
    emit: event => { events.push(event); onEvent?.(event) }, requestApproval: async () => ({ approved: true }),
  })
  const history: ModelMessage[] = Array.from({ length: 3 }, (_, index) => [
    { role: 'user' as const, content: `旧任务 ${index}：${'x'.repeat(64_000)}` },
    { role: 'assistant' as const, content: '旧任务已完成。' },
  ]).flat()
  session.restoreMessageSnapshot(history)
  return { session, events }
}

function overflow() {
  return new APICallError({
    message: 'maximum context length exceeded', statusCode: 400,
    url: 'http://localhost/model', requestBodyValues: {},
    responseBody: JSON.stringify({ error: { code: 'context_length_exceeded' } }),
  })
}

const usage = {
  inputTokens: { total: 60_000, noCache: 60_000, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
}

function summary(text = '已完成旧任务，继续处理用户最新要求。') {
  return {
    content: [{ type: 'text' as const, text: `<summary>${text}</summary>` }],
    finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [],
  }
}

function finalStep() {
  return { stream: simulateReadableStream({ chunks: [
    { type: 'text-start' as const, id: 'answer' },
    { type: 'text-delta' as const, id: 'answer', delta: '已完成。' },
    { type: 'text-end' as const, id: 'answer' },
    { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
  ] }) }
}
