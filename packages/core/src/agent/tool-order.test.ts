import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { simulateReadableStream, type ModelMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { parseTranscript } from '../session/chain.ts'
import { SessionStore } from '../session/store.ts'
import { TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from '../session/tool-execution.ts'
import { TASK_PLAN_TOOL_NAME } from '../tasks/tools.ts'
import { buildTool } from '../tools/tool.ts'
import { createCommandTools, CommandSessionManager } from '../tools/background-command/index.ts'
import { localWorkspace } from '../workspace/types.ts'
import { AgentSession, type ApprovalHandler } from './session.ts'

// 串行用例各自限时，避免前面的耗时挤占后续用例的等待预算。
describe('工具调用顺序与执行屏障', () => {
  const planItems = [
    { kind: 'work', outcome: '实现功能', status: 'in_progress' },
    { kind: 'work', outcome: '核对调用方' },
    { kind: 'verification', outcome: '完成验证' },
  ]
  const completeFirst = { action: 'update', changes: [
    { action: 'edit', item_id: 'T1', status: 'completed', evidence: ['新计划的验证记录'] },
  ] }

  for (const [reason, invalidCreate] of [
    ['参数缺失', { action: 'create', goal: '新计划' }],
    ['JSON 不完整', '{"action":"create","goal":"新计划","items":'],
    ['缺少最终验证项', { action: 'create', goal: '新计划', items: planItems.map(item => ({ ...item, kind: 'work' })) }],
  ] as const) {
    it(`计划创建失败（${reason}）时，同一步的更新和关闭保留原计划，独立读取照常执行`, async t => {
      const events: CoreEvent[] = []
      const f = await setup(t, [
        [TASK_PLAN_TOOL_NAME, { action: 'create', goal: '原计划', items: planItems }],
        [TASK_PLAN_TOOL_NAME, invalidCreate],
        [TASK_PLAN_TOOL_NAME, completeFirst],
        ['ListDir', { path: '.' }],
        [TASK_PLAN_TOOL_NAME, { action: 'close' }],
      ], event => events.push(event))
      assert.equal(await f.session.handleUserMessage('创建并更新新计划'), 'completed')
      const reopened = await f.store.open(f.journal.sessionId)
      const results = toolResults(reopened.initialMessages)
      assert.deepEqual(results.map(part => part.output.type), ['text', 'error-text', 'error-text', 'text', 'error-text'])
      for (const index of [2, 4]) {
        const { output } = results[index]!
        assert.equal(output.type, 'error-text')
        assert.match(output.value, /目标计划/)
      }
      const updates = events.filter(event => event.type === 'task-plan-updated')
      assert.equal(updates.length, 1)
      assert.equal(updates[0]!.plan.goal, '原计划')
      assert.deepEqual(reopened.initialTaskState, { version: 1, activePlan: updates[0]!.plan })
      assert.deepEqual(f.session.captureTaskStateSnapshot(), reopened.initialTaskState)
    })
  }

  it('同一步可重新创建计划，更新参数出错后仍可继续更新该计划', async t => {
    const f = await setup(t, [
      [TASK_PLAN_TOOL_NAME, { action: 'create', goal: '未建成', items: [] }],
      [TASK_PLAN_TOOL_NAME, { action: 'create', goal: '新计划', items: planItems }],
      [TASK_PLAN_TOOL_NAME, { action: 'update', changes: [] }],
      [TASK_PLAN_TOOL_NAME, completeFirst],
    ])
    assert.equal(await f.session.handleUserMessage('更正创建并记录进度'), 'completed')
    const reopened = await f.store.open(f.journal.sessionId)
    assert.deepEqual(toolResults(reopened.initialMessages).map(part => part.output.type), ['error-text', 'text', 'error-text', 'text'])
    assert.equal(reopened.initialTaskState?.activePlan?.goal, '新计划')
    assert.deepEqual(reopened.initialTaskState?.activePlan?.items[0]?.evidence, ['新计划的验证记录'])
  })

  it('同一 ManageCommand 的查询可并发，写入、EOF 和停止按调用顺序形成屏障', { timeout: 15_000 }, async t => {
    const taskId = crypto.randomUUID()
    const firstReads = [deferred(t), deferred(t)]
    const releaseReads = deferred(t)
    const writeStarted = deferred(t)
    const releaseWrite = deferred(t)
    const events: string[] = []
    const f = await setup(t, [
      ['ManageCommand', { action: 'read', taskId, offset: 0 }],
      ['ManageCommand', { action: 'read', taskId, offset: 1 }],
      ['ManageCommand', { action: 'write', taskId, input: 'yes\n' }],
      ['ManageCommand', { action: 'close', taskId }],
      ['ManageCommand', { action: 'stop', taskId }],
      ['ManageCommand', { action: 'read', taskId, offset: 2 }],
    ])
    const tool = createCommandTools(new CommandSessionManager('unused'), 'session').manageCommand
    f.session.setExtraTools([{ ...tool, async execute(input) {
      const label = `${input.action}:${input.offset ?? ''}`
      events.push(`start:${label}`)
      if (input.action === 'read' && input.offset < 2) {
        firstReads[input.offset]!.resolve()
        await releaseReads.promise
      }
      if (input.action === 'write') {
        writeStarted.resolve()
        await releaseWrite.promise
      }
      events.push(`end:${label}`)
      return { data: 'ok', isError: false }
    } }])
    const running = f.session.handleUserMessage('依次读取、交互与停止后台命令')
    await Promise.all(firstReads.map(gate => gate.promise))
    assert.deepEqual(events, ['start:read:0', 'start:read:1'])
    releaseReads.resolve()
    await writeStarted.promise
    assert.ok(events.includes('end:read:0') && events.includes('end:read:1'))
    assert.equal(events.at(-1), 'start:write:')
    releaseWrite.resolve()
    assert.equal(await running, 'completed')
    assert.deepEqual(events.slice(-7), [
      'end:write:', 'start:close:', 'end:close:', 'start:stop:', 'end:stop:', 'start:read:2', 'end:read:2',
    ])
  })

  it('新建后读取能看到文件，慢读取结束前不能覆盖文件', { timeout: 15_000 }, async (t) => {
    const started = deferred(t)
    const release = deferred(t)
    const f = await setup(t, [
      ['WriteFile', { path: 'value.txt', content: '第一版' }], ['ReadFile', { path: 'value.txt' }],
      ['SlowRead', {}], ['WriteFile', { path: 'value.txt', content: '第二版' }],
      ['ReadFile', { path: 'value.txt' }],
    ])
    f.session.setExtraTools([buildTool({
      name: 'SlowRead', description: '慢读取', prompt: '读取', inputSchema: z.object({}),
      isReadOnly: true, kind: 'read',
      async execute() {
        started.resolve()
        await release.promise
        return { data: await readFile(join(f.projectDir, 'value.txt'), 'utf8'), isError: false }
      },
    })])
    const running = f.session.handleUserMessage('按顺序写入与读取')
    await started.promise
    assert.equal(await readFile(join(f.projectDir, 'value.txt'), 'utf8'), '第一版')
    release.resolve()
    assert.equal(await running, 'completed')
    const results = toolResults(f.journal.initialMessages)
    assert.match(JSON.stringify(results[1]!.output), /第一版/)
    assert.match(JSON.stringify(results[2]!.output), /第一版/)
    assert.match(JSON.stringify(results[4]!.output), /第二版/)
    assert.equal(results.every((result) => result.output.type === 'text'), true)
  })

  it('连续只读调用最多并发十个，空出的槽位立即补入，写入等待整组完成', { timeout: 15_000 }, async (t) => {
    const started = Array.from({ length: 12 }, () => deferred(t))
    const release = Array.from({ length: 12 }, () => deferred(t))
    let active = 0
    let peak = 0
    const f = await setup(t, [
      ...started.map((_, value): Call => ['ReadProbe', { value }]),
      ['WriteFile', { path: 'after.txt', content: '读取完成' }],
    ])
    f.session.setExtraTools([buildTool({
      name: 'ReadProbe', description: '并发读取', prompt: '读取',
      inputSchema: z.object({ value: z.number() }), isReadOnly: true, kind: 'read',
      async execute({ value }) {
        peak = Math.max(peak, ++active)
        started[value]!.resolve()
        await release[value]!.promise
        active--
        return { data: `读取 ${value}`, isError: false }
      },
    })])
    const running = f.session.handleUserMessage('并发读取后写入')
    await Promise.all(started.slice(0, 10).map((gate) => gate.promise))
    assert.equal(active, 10)
    release[9]!.resolve()
    await started[10]!.promise
    assert.equal(active, 10, '不等待最早的慢调用，空槽可由下一只读调用使用')
    release[10]!.resolve()
    await started[11]!.promise
    assert.deepEqual(await readdir(f.projectDir), [])
    release.forEach((gate) => gate.resolve())
    assert.equal(await running, 'completed')
    assert.equal(peak, 10)
    assert.equal(await readFile(join(f.projectDir, 'after.txt'), 'utf8'), '读取完成')
  })

  for (const mode of ['complete', 'stop', 'urgent'] as const) {
    it(`${mode}：快结果立即落盘，恢复与下一次请求仍按调用顺序，未开始的屏障不会偷跑`, { timeout: 15_000 }, async (t) => {
      const release = deferred(t)
      const fastSaved = deferred(t)
      const f = await setup(t, [
        ['ReadProbe', { value: 1 }], ['ReadProbe', { value: 2 }],
        ['WriteFile', { path: 'after.txt', content: '屏障之后' }],
      ], (event) => {
        if (event.type === 'tool-end' && event.toolUseId === 'call-2') fastSaved.resolve()
      })
      f.session.setExtraTools([buildTool({
        name: 'ReadProbe', description: '乱序读取', prompt: '读取',
        inputSchema: z.object({ value: z.number() }), isReadOnly: true, kind: 'read',
        async execute({ value }) {
          if (value === 1) await release.promise
          return { data: `真实读取 ${value}`, isError: false }
        },
      })])
      const running = f.session.handleUserMessage('先读取再写入')
      await fastSaved.promise
      const raw = parseTranscript(await readFile(f.transcript, 'utf8'))
      const rawMessages = raw.flatMap((entry) => entry.type === 'messages' ? entry.messages : [])
      assert.deepEqual(toolResults(rawMessages).map((part) => part.toolCallId), ['call-2'])
      const crash = toolResults((await f.store.open(f.journal.sessionId)).initialMessages)
      assert.deepEqual(crash.map((part) => part.toolCallId), ['call-1', 'call-2', 'call-3'])
      assert.deepEqual(crash[0]!.output, { type: 'error-text', value: TOOL_OUTCOME_UNKNOWN })
      assert.deepEqual(crash[1]!.output, { type: 'text', value: '真实读取 2' })
      assert.deepEqual(crash[2]!.output, { type: 'error-text', value: TOOL_NOT_STARTED })
      if (mode === 'stop') f.session.abort()
      if (mode === 'urgent') await f.session.handleUserMessage('总结实际状态', true)
      release.resolve()
      assert.equal(await running, mode === 'stop' ? 'aborted' : 'completed')
      if (mode === 'stop') await f.session.handleUserMessage('总结实际状态')
      const next = f.model.doStreamCalls[1]!.prompt.flatMap((message) =>
        message.role === 'tool' ? message.content.filter((part) => part.type === 'tool-result') : [])
      assert.deepEqual(next.map((part) => part.toolCallId), ['call-1', 'call-2', 'call-3'])
      assert.match(JSON.stringify(next[0]), /真实读取 1/)
      const reopened = await f.store.open(f.journal.sessionId)
      assert.deepEqual(toolResults(reopened.initialMessages), toolResults(f.journal.initialMessages))
      assert.deepEqual(await readdir(f.projectDir), mode === 'complete' ? ['after.txt'] : [])
    })
  }

  it('前一个调用等待审批时，后一个已允许的状态操作不能越过它', { timeout: 15_000 }, async (t) => {
    const shown = deferred(t)
    const approved = deferred(t)
    const executions: string[] = []
    const f = await setup(t, [['NeedsApproval', {}], ['Allowed', {}]], undefined, async () => {
      shown.resolve()
      await approved.promise
      return { approved: true }
    })
    f.session.setPermissionMode('default')
    f.session.setExtraTools(['NeedsApproval', 'Allowed'].map((name) => buildTool({
      name, description: name, prompt: name, inputSchema: z.object({}),
      isReadOnly: false, kind: 'control',
      ...(name === 'NeedsApproval' ? { initialApprovalReason: '需要授权' } : {}),
      async execute() { executions.push(name); return { data: name, isError: false } },
    })))
    const running = f.session.handleUserMessage('按原顺序执行')
    await shown.promise
    assert.deepEqual(executions, [])
    approved.resolve()
    assert.equal(await running, 'completed')
    assert.deepEqual(executions, ['NeedsApproval', 'Allowed'])
  })

  it('只读工具的已知错误不误报成副作用结果未知', { timeout: 15_000 }, async (t) => {
    const f = await setup(t, [['FailRead', {}]])
    f.session.setExtraTools([buildTool({
      name: 'FailRead', description: '失败读取', prompt: '读取', inputSchema: z.object({}),
      isReadOnly: true, kind: 'read', async execute() { throw new Error('文件不可读') },
    })])
    assert.equal(await f.session.handleUserMessage('读取'), 'completed')
    const result = toolResults(f.journal.initialMessages)[0]!
    assert.equal(result.output.type, 'error-text')
    assert.match(JSON.stringify(result), /文件不可读/)
    assert.doesNotMatch(JSON.stringify(result), /结果未知|工具未执行/)
  })

  it('并发结果落盘失败后排空已启动调用，并阻止后续写入与模型续轮', { timeout: 15_000 }, async (t) => {
    const started = deferred(t)
    const release = deferred(t)
    const failed = deferred(t)
    const f = await setup(t, [
      ['ReadProbe', { value: 1 }], ['ReadProbe', { value: 2 }],
      ['WriteFile', { path: 'after.txt', content: '不能写入' }],
    ])
    const recordStep = f.journal.recordStep.bind(f.journal)
    f.journal.recordStep = async (...args) => {
      if (toolResults(args[1]).some((part) => part.toolCallId === 'call-2')) {
        failed.resolve()
        throw new Error('结果落盘失败')
      }
      return recordStep(...args)
    }
    let drained = false
    f.session.setExtraTools([buildTool({
      name: 'ReadProbe', description: '读取', prompt: '读取',
      inputSchema: z.object({ value: z.number() }), isReadOnly: true, kind: 'read',
      async execute({ value }) {
        if (value === 1) { started.resolve(); await release.promise; drained = true }
        else await started.promise
        return { data: '读取完成', isError: false }
      },
    })])
    const running = f.session.handleUserMessage('读取后写入')
    await failed.promise
    assert.equal(drained, false)
    release.resolve()
    assert.equal(await running, 'error')
    assert.equal(drained, true)
    assert.equal(f.model.doStreamCalls.length, 1)
    assert.deepEqual(await readdir(f.projectDir), [])
  })
})

type Call = [toolName: string, input: Record<string, unknown> | string]

async function setup(
  t: TestContext, calls: Call[], emit: (event: CoreEvent) => void = () => {},
  requestApproval: ApprovalHandler = async () => ({ approved: true }),
) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-tool-order-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectDir = join(root, 'project')
  await mkdir(projectDir)
  const store = new SessionStore(join(root, 'sessions'))
  const journal = await store.create({ workspace: localWorkspace(projectDir), modelId: 'test:order' })
  const model = new MockLanguageModelV4({ doStream: [
    { stream: simulateReadableStream({ chunks: [
      ...calls.map(([toolName, input], index) => ({
        type: 'tool-call' as const, toolCallId: `call-${index + 1}`, toolName,
        input: typeof input === 'string' ? input : JSON.stringify(input),
      })),
      { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
    ] }) },
    { stream: simulateReadableStream({ chunks: [
      { type: 'text-start' as const, id: 'answer' }, { type: 'text-delta' as const, id: 'answer', delta: '完成' },
      { type: 'text-end' as const, id: 'answer' },
      { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
    ] }) },
  ] })
  const entry: ModelEntry = {
    id: 'test:order', displayName: '工具顺序测试', provider: 'openai', protocol: 'openai-responses',
    capabilities: { supportsNativeTools: true, supportsImageInput: false, reasoningExposure: 'none', structuredOutput: 'tool-based', promptCaching: 'none', contextWindow: 100_000, maxOutput: 4096 },
    create: () => model,
  }
  const session = new AgentSession({
    model: entry, providerConfig: { apiKey: 'test' }, sessionRecorder: journal,
    promptContext: { projectDir, osPlatform: 'win32' }, emit, requestApproval,
  })
  session.setPermissionMode('auto')
  return { projectDir, store, journal, model, session, transcript: join(root, 'sessions', journal.sessionId, 'transcript.jsonl') }
}

function toolResults(messages: readonly ModelMessage[]) {
  return messages.flatMap((message) => message.role === 'tool' ? message.content.filter((part) => part.type === 'tool-result') : [])
}

function deferred(t: TestContext) {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  t.after(() => resolve())
  return { promise, resolve }
}

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 5, text: 5, reasoning: undefined } }
