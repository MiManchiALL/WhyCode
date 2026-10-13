import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { SessionStore } from '../session/store.ts'
import { localWorkspace } from '../workspace/types.ts'
import { AgentSession } from './session.ts'
import type { ModelEntry } from '../providers/registry.ts'

const marker = '<whycode-browser-guide:v1>'
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}
function step(input?: unknown) {
  return { stream: simulateReadableStream({ chunks: [
    ...(input === undefined ? [
      { type: 'text-start' as const, id: 'text' },
      { type: 'text-delta' as const, id: 'text', delta: '完成' },
      { type: 'text-end' as const, id: 'text' },
    ] : [{ type: 'tool-call' as const, toolCallId: crypto.randomUUID(), toolName: 'Browser', input: JSON.stringify(input) }]),
    { type: 'finish' as const, finishReason: { unified: input === undefined ? 'stop' as const : 'tool-calls' as const, raw: undefined }, usage },
  ] }) }
}
function entry(model: MockLanguageModelV4): ModelEntry {
  return { id: 'test:browser', displayName: 'Browser test', provider: 'openai', protocol: 'openai-responses',
    capabilities: { supportsNativeTools: true, supportsImageInput: false, reasoningExposure: 'none',
      structuredOutput: 'tool-based', promptCaching: 'none', contextWindow: 100_000, maxOutput: 4000 }, create: () => model }
}

test('Browser 指引仅投影当前 Turn 尾部，工具目录与 System 不变，持久历史不保存指引', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-browser-context-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new SessionStore(root)
  const recorder = await store.create({ workspace: localWorkspace(null), modelId: 'test:browser' })
  const model = new MockLanguageModelV4({ doStream: [step({}), step({ code: 'text(await browser.tabs())' }), step(), step()] })
  const completed: string[] = []
  const executed: string[] = []
  const session = new AgentSession({ model: entry(model), providerConfig: { apiKey: 'test' }, sessionRecorder: recorder,
    promptContext: { projectDir: root, osPlatform: 'win32' }, emit: () => {}, requestApproval: async () => ({ approved: true, remember: true }),
    browser: { execute: async (_code, context) => {
      executed.push(context.turnId!); return { text: 'browser-result', isError: false, images: [] }
    }, finishTurn: async turn => { completed.push(turn) } },
  })
  assert.equal(await session.handleUserMessage('检查网页'), 'completed')
  assert.equal(executed.length, 1)
  assert.equal(completed[0], executed[0])
  const [initial, guided, afterTool] = model.doStreamCalls
  assert.ok(initial && guided && afterTool)
  assert.equal(JSON.stringify(initial.prompt).includes(marker), false)
  for (const call of [guided, afterTool]) {
    assert.equal(JSON.stringify(call.prompt).split(marker).length - 1, 1)
    assert.ok(JSON.stringify(call.prompt.at(-1)).includes(marker))
    assert.deepEqual(call.tools, initial.tools)
    assert.deepEqual(call.prompt[0], initial.prompt[0])
  }
  const reopened = await store.open(recorder.sessionId)
  assert.equal(JSON.stringify(reopened.initialMessages).includes(marker), false)
  assert.ok(JSON.stringify(reopened.initialMessages).includes('browser-result'))
  assert.equal(await session.handleUserMessage('普通下一轮'), 'completed')
  assert.equal(JSON.stringify(model.doStreamCalls[3]?.prompt).includes(marker), false)
  assert.equal(completed.length, 2)
})

test('停止 Browser 工具后仍结束浏览器生命周期，下一轮不残留指引', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-browser-stop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const recorder = await new SessionStore(root).create({ workspace: localWorkspace(null), modelId: 'test:browser' })
  const model = new MockLanguageModelV4({ doStream: [step({}), step({ code: 'await browser.open()' }), step()] })
  let finished = 0
  const session = new AgentSession({ model: entry(model), providerConfig: { apiKey: 'test' }, sessionRecorder: recorder,
    promptContext: { projectDir: root, osPlatform: 'win32' }, emit: () => {}, requestApproval: async () => ({ approved: true }),
    browser: { execute: async (_code, context) => {
      session.abort()
      context.abortSignal.throwIfAborted()
      throw new Error('停止应取消工具')
    }, finishTurn: async () => { finished++ } },
  })
  assert.equal(await session.handleUserMessage('检查网页'), 'aborted')
  assert.equal(finished, 1)
  await session.handleUserMessage('继续普通对话')
  assert.equal(JSON.stringify(model.doStreamCalls.at(-1)?.prompt).includes(marker), false)
})
