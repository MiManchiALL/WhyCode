import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { simulateReadableStream, type ModelMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import { TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN, toolResultMessage } from '../session/tool-execution.ts'
import { buildTool } from '../tools/tool.ts'
import { localWorkspace } from '../workspace/types.ts'
import { AgentSession, type ApprovalHandler } from './session.ts'

describe('中断工具批次的执行事实', () => {
  for (const mode of ['stop', 'urgent'] as const) {
    it(`${mode} 取消等待中的审批，不阻塞批次收尾或执行被取消的写入`, async (t) => {
      const fixture = await setup(t)
      const shown = deferred()
      const model = new MockLanguageModelV4({ doStream: [
        callsStep([['WriteFile', { path: 'approval.txt', content: '不能写入' }]]), finalStep(),
      ] })
      const session = createSession(fixture, model, () => {}, async (_request, signal) => {
        shown.resolve()
        await untilAborted(signal)
        return { approved: false }
      })
      session.setPermissionMode('default')
      const running = session.handleUserMessage('写文件')
      await shown.promise
      if (mode === 'stop') session.abort()
      else await session.handleUserMessage('改为只看执行记录', true)
      assert.equal(await running, mode === 'stop' ? 'aborted' : 'completed')
      assert.deepEqual(await readdir(fixture.projectDir), [])
      const results = toolResults((await fixture.store.open(fixture.journal.sessionId)).initialMessages)
      assert.equal(results.length, 1)
      assert.match(JSON.stringify(results[0]), /工具未执行/)
      if (mode === 'urgent') assert.match(JSON.stringify(model.doStreamCalls[1]!.prompt), /工具未执行/)
    })
  }

  it('模型只生成部分响应时不提前执行已经完整的工具参数', async (t) => {
    const fixture = await setup(t)
    const generated = deferred()
    const model = new MockLanguageModelV4({ doStream: async (options) => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'tool-call', toolCallId: 'partial', toolName: 'WriteFile', input: JSON.stringify({ path: 'partial.txt', content: '不能提前写入' }) })
          generated.resolve()
          options.abortSignal?.addEventListener('abort', () => controller.close(), { once: true })
        },
      }),
    }) })
    const session = createSession(fixture, model)
    const running = session.handleUserMessage('写文件')
    await generated.promise
    session.abort()
    assert.equal(await running, 'aborted')
    assert.deepEqual(await readdir(fixture.projectDir), [])
    assert.equal(toolResults((await fixture.store.open(fixture.journal.sessionId)).initialMessages).length, 0)
  })

  for (const mode of ['stop', 'urgent', 'queued'] as const) {
    it(`${mode} 保留真实写入，配齐五个调用，再处理下一条消息`, async (t) => {
      const fixture = await setup(t)
      const started = deferred()
      const release = deferred()
      const blocker = buildTool({
        name: 'Hold', description: '中断探针', prompt: '等待测试收尾',
        inputSchema: z.object({}), isReadOnly: false, kind: 'control',
        async execute(_input, context) {
          started.resolve()
          await Promise.race([release.promise, untilAborted(context.abortSignal)])
          return { data: '等待结束', isError: context.abortSignal.aborted }
        },
      })
      const model = new MockLanguageModelV4({ doStream: [batchStep(), finalStep()] })
      const events: CoreEvent[] = []
      const session = createSession(fixture, model, (event) => events.push(event))
      session.setExtraTools([blocker])
      const running = session.handleUserMessage('一次调用五个工具')
      await started.promise
      assert.equal(await readFile(join(fixture.projectDir, 'first.txt'), 'utf8'), '已写入')
      const crashView = await fixture.store.open(fixture.journal.sessionId)
      assert.deepEqual(toolResults(crashView.initialMessages).slice(1).map((result) => result.output), [
        { type: 'error-text', value: TOOL_OUTCOME_UNKNOWN },
        ...[3, 4, 5].map(() => ({ type: 'error-text', value: TOOL_NOT_STARTED })),
      ])
      if (mode === 'stop') session.abort()
      else await session.handleUserMessage('接下来只查看执行记录', mode === 'urgent')
      if (mode === 'queued') release.resolve()
      assert.equal(await running, mode === 'stop' ? 'aborted' : 'completed')
      if (mode === 'stop') {
        assert.equal(model.doStreamCalls.length, 1, '停止不自动续跑')
        await session.handleUserMessage('接下来只查看执行记录')
      }
      assert.deepEqual(await readdir(fixture.projectDir), mode === 'queued'
        ? ['first.txt', 'later-3.txt', 'later-4.txt', 'later-5.txt'] : ['first.txt'])
      const next = JSON.stringify(model.doStreamCalls[1]!.prompt)
      assert.match(next, /first.txt/)
      assert.match(next, /接下来只查看执行记录/)
      const reopened = await fixture.store.open(fixture.journal.sessionId)
      const results = toolResults(reopened.initialMessages)
      assert.equal(results.length, 5)
      assert.equal(results[0]!.output.type, 'text')
      if (mode !== 'queued') {
        assert.deepEqual(results[1]!.output, { type: 'error-text', value: '等待结束' })
        for (const result of results.slice(2)) assert.deepEqual(result.output, { type: 'error-text', value: TOOL_NOT_STARTED })
      }
      assert.equal(events.filter((event) => event.type === 'tool-end').length, 5)
      assert.equal(events.some((event) => event.type === 'step-discarded'), false)
    })
  }

  it('立即插话等待已开始的并行调用收尾，迟到的成功结果仍按实际记录', async (t) => {
    const fixture = await setup(t)
    const started = deferred()
    const release = deferred()
    const slow = buildTool({
      name: 'SlowRead', description: '读取探针', prompt: '读取',
      inputSchema: z.object({}), isReadOnly: true, kind: 'read',
      async execute() {
        started.resolve()
        await release.promise
        return { data: '中断后才返回的实际结果', isError: false }
      },
    })
    const model = new MockLanguageModelV4({ doStream: [callsStep([['SlowRead', {}]]), finalStep()] })
    const session = createSession(fixture, model)
    session.setExtraTools([slow])
    const running = session.handleUserMessage('读取')
    await started.promise
    await session.handleUserMessage('改为总结', true)
    assert.equal(model.doStreamCalls.length, 1)
    release.resolve()
    assert.equal(await running, 'completed')
    assert.match(JSON.stringify(model.doStreamCalls[1]!.prompt), /中断后才返回的实际结果/)
    assert.equal(toolResults((await fixture.store.open(fixture.journal.sessionId)).initialMessages)[0]!.output.type, 'text')
  })

  it('工具写入后抛出异常仍保留调用与错误，不能宣称未执行', async (t) => {
    const fixture = await setup(t)
    const failing = buildTool({
      name: 'FailAfterWrite', description: '异常探针', prompt: '写入后失败',
      inputSchema: z.object({}), isReadOnly: false, kind: 'control',
      async execute() {
        await writeFile(join(fixture.projectDir, 'changed.txt'), '不可丢失的事实')
        throw new Error('写入后的异常')
      },
    })
    const model = new MockLanguageModelV4({ doStream: [callsStep([[failing.name, {}]]), finalStep()] })
    const session = createSession(fixture, model)
    session.setExtraTools([failing])
    assert.equal(await session.handleUserMessage('运行'), 'completed')
    assert.equal(await readFile(join(fixture.projectDir, 'changed.txt'), 'utf8'), '不可丢失的事实')
    const result = toolResults((await fixture.store.open(fixture.journal.sessionId)).initialMessages)[0]!
    assert.equal(result.output.type, 'error-text')
    assert.deepEqual(result.output, { type: 'error-text', value: '工具执行出错：写入后的异常' })
    assert.match(JSON.stringify(model.doStreamCalls[1]!.prompt), /写入后的异常/)
  })

  it('写文件在写入前失败时只回传实际错误，不谎报结果丢失', async (t) => {
    const fixture = await setup(t)
    await mkdir(join(fixture.projectDir, 'directory'))
    const model = new MockLanguageModelV4({ doStream: [
      callsStep([['WriteFile', { path: 'directory', content: '不能写入目录' }]]), finalStep(),
    ] })
    assert.equal(await createSession(fixture, model).handleUserMessage('写文件'), 'completed')
    const results = toolResults((await fixture.store.open(fixture.journal.sessionId)).initialMessages)
    assert.equal(results.length, 1)
    assert.match(JSON.stringify(results), /工具执行出错/)
    assert.doesNotMatch(JSON.stringify(results), /结果未知/)
    assert.deepEqual(await readdir(join(fixture.projectDir, 'directory')), [])
    assert.doesNotMatch(JSON.stringify(model.doStreamCalls[1]!.prompt), /结果未知/)
  })

  for (const form of ['return', 'throw'] as const) {
    it(`立即插话保留 ${form} 的明确失败，历史与下一次模型请求各有一个结果`, async (t) => {
      const fixture = await setup(t)
      const started = deferred()
      const tool = buildTool({
        name: 'ValidateOnly', description: '预检失败', prompt: '检查输入',
        inputSchema: z.object({}), isReadOnly: false, kind: 'control',
        async execute(_input, ctx) {
          started.resolve()
          await untilAborted(ctx.abortSignal)
          if (form === 'throw') throw new Error('目标不存在，未执行')
          return { data: '目标不存在，未执行', isError: true }
        },
      })
      const model = new MockLanguageModelV4({ doStream: [callsStep([[tool.name, {}]]), finalStep()] })
      const session = createSession(fixture, model)
      session.setExtraTools([tool])
      const run = session.handleUserMessage('执行')
      await started.promise
      await session.handleUserMessage('先解释失败原因', true)
      assert.equal(await run, 'completed')
      const results = toolResults((await fixture.store.open(fixture.journal.sessionId)).initialMessages)
      assert.equal(results.length, 1)
      assert.deepEqual(results[0]!.output, {
        type: 'error-text', value: `${form === 'throw' ? '工具执行出错：' : ''}目标不存在，未执行`,
      })
      const prompt = JSON.stringify(model.doStreamCalls[1]!.prompt)
      assert.match(prompt, /目标不存在，未执行/)
      assert.doesNotMatch(prompt, /结果未知/)
    })
  }

  it('重启按执行入口区分未知与未执行，保留完成结果与供应商元数据，恢复幂等', async (t) => {
    const fixture = await setup(t)
    const turnId = crypto.randomUUID()
    await fixture.journal.recordTurnStart(turnId, [{ role: 'user', content: '执行三项' }])
    const calls = [1, 2, 3].map((n) => ({ type: 'tool-call' as const, toolCallId: `call-${n}`, toolName: 'WriteFile', input: { path: `${n}.txt`, content: 'ok' } }))
    const head: ModelMessage = { role: 'assistant', content: [
      { type: 'reasoning', text: '处理计划', providerOptions: { anthropic: { signature: 'signed-reasoning' } } }, ...calls,
    ] }
    await fixture.journal.recordStep(turnId, [head])
    await fixture.journal.recordStep(turnId, [], undefined, undefined, { startedToolCallId: 'call-1' })
    await fixture.journal.recordStep(turnId, [toolResultMessage(calls[0]!, '确实完成')])
    await fixture.journal.recordStep(turnId, [], undefined, undefined, { startedToolCallId: 'call-2' })
    const reopened = await fixture.store.open(fixture.journal.sessionId)
    assert.deepEqual(reopened.initialMessages[1], head)
    assert.deepEqual(toolResults(reopened.initialMessages).map((part) => part.output), [
      { type: 'text', value: '确实完成' },
      { type: 'error-text', value: TOOL_OUTCOME_UNKNOWN },
      { type: 'error-text', value: TOOL_NOT_STARTED },
    ])
    await reopened.recoverInterruptedWork()
    const again = await fixture.store.open(reopened.sessionId)
    assert.equal(toolResults(again.initialMessages).length, 3)
    assert.match(JSON.stringify(again.initialMessages), /不要自动继续旧任务/)
    const model = new MockLanguageModelV4({ doStream: [finalStep()] })
    await createSession({ ...fixture, journal: again }, model).handleUserMessage('总结实际状态')
    assert.match(JSON.stringify(model.doStreamCalls[0]!.prompt), /工具执行结果未知/)
  })

  it('结果持久化失败后停止后续写入，重启保留已完成结果并标明未知状态', async (t) => {
    const fixture = await setup(t)
    const original = fixture.journal.recordStep.bind(fixture.journal)
    fixture.journal.recordStep = async (...args) => {
      if (toolResults(args[1]).some((result) => result.toolCallId === 'call-2')) {
        throw new Error('工具结果写盘失败')
      }
      return original(...args)
    }
    const model = new MockLanguageModelV4({ doStream: [callsStep([1, 2, 3].map((n) =>
      ['WriteFile', { path: `${n}.txt`, content: '实际写入' }]))] })
    const session = createSession(fixture, model)
    assert.equal(await session.handleUserMessage('依次写入三个文件'), 'error')
    assert.deepEqual(await readdir(fixture.projectDir), ['1.txt', '2.txt'])
    assert.equal(model.doStreamCalls.length, 1)
    const results = toolResults((await fixture.store.open(fixture.journal.sessionId)).initialMessages)
    assert.equal(results.length, 3)
    assert.equal(results[0]!.output.type, 'text')
    assert.deepEqual(results[1]!.output, { type: 'error-text', value: TOOL_OUTCOME_UNKNOWN })
    assert.deepEqual(results[2]!.output, { type: 'error-text', value: TOOL_NOT_STARTED })
  })

  it('调用或执行入口持久化失败时不产生文件副作用', async (t) => {
    for (const boundary of ['calls', 'start']) {
      const fixture = await setup(t)
      const original = fixture.journal.recordStep.bind(fixture.journal)
      fixture.journal.recordStep = async (...args) => {
        if (boundary === 'calls' && args[1].some((m) => m.role === 'assistant')
          || boundary === 'start' && args[4]?.startedToolCallId) throw new Error('磁盘写入失败')
        return original(...args)
      }
      const model = new MockLanguageModelV4({ doStream: [callsStep([['WriteFile', { path: 'first.txt', content: '不能写' }]])] })
      const session = createSession(fixture, model)
      assert.equal(await session.handleUserMessage('写入'), 'error')
      assert.deepEqual(await readdir(fixture.projectDir), [])
      assert.equal(model.doStreamCalls.length, 1)
    }
  })
})

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-interrupted-tools-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectDir = join(root, 'project')
  await mkdir(projectDir)
  const store = new SessionStore(join(root, 'sessions'))
  const journal = await store.create({ workspace: localWorkspace(projectDir), modelId: 'test:tools' })
  return { root, projectDir, store, journal }
}

function createSession(
  fixture: Awaited<ReturnType<typeof setup>>, model: MockLanguageModelV4,
  emit: (event: CoreEvent) => void = () => {},
  requestApproval: ApprovalHandler = async () => ({ approved: true }),
) {
  const entry: ModelEntry = {
    id: 'test:tools', displayName: '工具执行测试', provider: 'openai', protocol: 'openai-responses',
    capabilities: { supportsNativeTools: true, supportsImageInput: false, reasoningExposure: 'none', structuredOutput: 'tool-based', promptCaching: 'none', contextWindow: 100_000, maxOutput: 4096 },
    create: () => model,
  }
  const session = new AgentSession({
    model: entry, providerConfig: { apiKey: 'test' }, sessionRecorder: fixture.journal,
    promptContext: { projectDir: fixture.projectDir, osPlatform: 'win32' },
    emit, requestApproval,
  })
  session.setPermissionMode('auto')
  return session
}

function toolResults(messages: readonly ModelMessage[]) {
  return messages.flatMap((message) => message.role === 'tool' ? message.content.filter((part) => part.type === 'tool-result') : [])
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } }

function batchStep() {
  return callsStep([
    ['WriteFile', { path: 'first.txt', content: '已写入' }], ['Hold', {}],
    ...[3, 4, 5].map((n): [string, unknown] => ['WriteFile', { path: `later-${n}.txt`, content: '排队的写入' }]),
  ])
}

function callsStep(calls: [string, unknown][]) {
  return { stream: simulateReadableStream({ chunks: [
    ...calls.map(([toolName, input], n) => ({ type: 'tool-call' as const, toolCallId: `call-${n + 1}`, toolName, input: JSON.stringify(input) })),
    { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
  ] }) }
}

function finalStep() {
  return { stream: simulateReadableStream({ chunks: [
    { type: 'text-start' as const, id: 'answer' },
    { type: 'text-delta' as const, id: 'answer', delta: '已核对。' },
    { type: 'text-end' as const, id: 'answer' },
    { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
  ] }) }
}
