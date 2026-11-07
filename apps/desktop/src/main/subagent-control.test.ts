import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { AgentSession, buildTool, MAX_SUBAGENT_RESULT_CHARS, SessionJournal } from '@whycode/core'
import { createFixture, deferred, finalStream, languageModel, modelEntry, toolCallsStream, toolStream } from './subagent-test-fixture.ts'
import { SubagentService } from './subagent-service.ts'
import { SubagentStorage } from './subagent-storage.ts'

describe('子代理控制与被动恢复', { timeout: 30_000 }, () => {
  it('父模型同一步两次 send 依次交付给同一实例，只创建一次继续激活', async () => {
    const finish = deferred<void>()
    const f = await createFixture([], async index => {
      if (index === 1) await finish.promise
      return finalStream('已处理。')
    })
    const tools = f.service.createTools(f.runtime, f.parentJournal, f.projectDir)
    const id = idFrom((await tools[0]!.execute({
      action: 'spawn', name: 'explore', description: '调查', prompt: '首次调查',
    }, f.toolContext('origin', 'spawn'))).data)
    await f.waitForSettlements(1)
    let results: string | undefined
    const parent = new AgentSession({
      model: modelEntry(languageModel(async call => {
        const toolResults = call.prompt.filter(message => message.role === 'tool')
        if (!toolResults.length) return toolCallsStream(['核对来源', '补充证据'].map((prompt, index) => ({
          toolName: 'Subagent', toolCallId: `send-${index}`, input: { action: 'send', subagent_id: id, prompt },
        })))
        results = JSON.stringify(toolResults)
        return finalStream('两条指示均已发送。')
      })),
      providerConfig: { apiKey: 'test' }, promptContext: { projectDir: f.projectDir, osPlatform: 'win32' },
      mainTools: tools, emit: () => {}, requestApproval: async () => ({ approved: true }),
    })
    try {
      assert.equal(await parent.handleUserMessage('更新同一个子代理'), 'completed')
      assert.equal(results?.match(/已发送消息给子代理/g)?.length, 2)
    } finally {
      finish.resolve()
      await parent.dispose()
    }
    await f.waitForSettlements(2)
    assert.match(JSON.stringify(f.modelCalls.at(-1)!.prompt), /核对来源.*补充证据/s)
    assert.equal((await f.service.state(f.parentJournal.sessionId)).subagents[0]?.activationCount, 2)
  })

  it('运行中 send 在工具结束后交付，不打断工具，也不新建激活', async () => {
    const started = deferred<void>()
    const release = deferred<void>()
    let signal: AbortSignal | undefined
    const fixture = await createFixture([], async (index, call) => {
      if (index === 0) return toolStream('WebFetch', {})
      assert.match(JSON.stringify(call.prompt), /工具完整完成/)
      assert.match(JSON.stringify(call.prompt), /补充核验范围/)
      return finalStream('完成补充核验。')
    }, undefined, {
      createWebPageTools: () => [buildTool({
        name: 'WebFetch', description: '等待边界', prompt: '等待', inputSchema: z.object({}),
        kind: 'read', isReadOnly: true,
        async execute(_input, context) {
          signal = context.abortSignal
          started.resolve()
          await release.promise
          return { data: '工具完整完成', isError: false }
        },
      })],
    })
    const [tool] = fixture.service.createTools(fixture.runtime, fixture.parentJournal, fixture.projectDir)
    const ctx = fixture.toolContext('parent', 'spawn')
    const launched = await tool!.execute({ action: 'spawn', name: 'explore', description: '等待工具', prompt: '调用工具' }, ctx)
    const id = idFrom(launched.data)
    await started.promise
    const sent = await tool!.execute({ action: 'send', subagent_id: id, prompt: '补充核验范围' }, ctx)
    assert.equal(sent.isError, false)
    assert.equal(signal?.aborted, false)
    assert.equal(fixture.modelCalls.length, 1)
    release.resolve()
    await fixture.waitForSettlements(1)
    assert.equal(fixture.modelCalls.length, 2)
    assert.equal((await fixture.service.state(fixture.parentJournal.sessionId)).subagents[0]?.activationCount, 1)
    assert.equal(fixture.settlements[0]?.resultText, '完成补充核验。')
  })

  it('stop 只取消指定子代理，保留分段正文，且可 send 继续同一实例', async () => {
    const ready = [deferred<void>(), deferred<void>()]
    const signals: AbortSignal[] = []
    const fixture = await createFixture([], async (index, { abortSignal }) => {
      if (index >= 2) return finalStream('已继续并完成。')
      assert.ok(abortSignal)
      signals.push(abortSignal)
      return heldText(abortSignal, [`调查${index}第一段`, '尚在核查第二段'])
    }, undefined, {
      onEvent: ({ event }) => {
        if (event.type === 'text-delta' && event.text.includes('尚在核查')) {
          ready[signals.length - 1]!.resolve()
        }
      },
    })
    const [tool] = fixture.service.createTools(fixture.runtime, fixture.parentJournal, fixture.projectDir)
    const ctx = fixture.toolContext('parent', 'control')
    const ids: string[] = []
    for (let i = 0; i < 2; i++) {
      ids.push(idFrom((await tool!.execute({ action: 'spawn', name: 'explore', description: `调查${i}`, prompt: `调查${i}` }, ctx)).data))
      await ready[i]!.promise
    }
    const approvalId = randomUUID()
    const unrelatedApproval = fixture.runtime.requestApproval({
      requestId: approvalId, toolName: 'RunCommand', input: {}, reason: '其它任务的审批',
    })
    const stopped = await tool!.execute({ action: 'stop', subagent_id: ids[0] }, ctx)
    assert.equal(stopped.isError, false)
    assert.equal(fixture.runtime.respondApproval(approvalId, { approved: true }), true)
    assert.equal((await unrelatedApproval).approved, true)
    assert.equal(signals[0]?.aborted, true)
    assert.equal(signals[1]?.aborted, false)
    assert.equal(fixture.settlements[0]?.outcome, 'aborted')
    assert.match(fixture.settlements[0]?.resultText ?? '', /调查0第一段\n\n尚在核查第二段\n\n\[输出中断/)
    assert.equal((await fixture.service.list(fixture.parentJournal.sessionId)).find(item => item.subagentId === ids[1])?.status, 'running')
    const continued = await tool!.execute({ action: 'send', subagent_id: ids[0], prompt: '继续核查' }, ctx)
    assert.equal(continued.isError, false)
    await fixture.waitForSettlements(2)
    assert.equal(fixture.settlements[1]?.subagentId, ids[0])
    assert.equal(fixture.settlements[1]?.outcome, 'completed')
  })

  it('重启恢复完整和中断结果均不唤醒父模型，只按需交付且不取前一次激活正文', async () => {
    const partial = deferred<void>()
    const fixture = await createFixture(['完整结果'], async (index, { abortSignal }) => {
      if (index === 0) return finalStream('完整结果')
      assert.ok(abortSignal)
      return heldText(abortSignal, ['本次留下的半段'])
    }, undefined, { onEvent: ({ event }) => {
      if (event.type === 'text-delta' && event.text === '本次留下的半段') partial.resolve()
    } })
    const [tool] = fixture.service.createTools(fixture.runtime, fixture.parentJournal, fixture.projectDir)
    const ctx = fixture.toolContext('parent', 'control')
    const id = idFrom((await tool!.execute({ action: 'spawn', name: 'explore', description: '多次核查', prompt: '首次' }, ctx)).data)
    await fixture.waitForSettlements(1)
    await tool!.execute({ action: 'send', subagent_id: id, prompt: '第二次' }, ctx)
    await partial.promise
    await fixture.service.close()
    assert.equal(fixture.settlements.length, 1, '关闭时不发唤醒通知')
    const storage = new SubagentStorage(fixture.sessionsRoot)
    const manifest = await storage.readManifest(fixture.parentJournal.sessionId, id)
    const last = manifest.activations.at(-1)!
    delete last.outcome
    delete last.resultText
    delete last.endedAt
    delete last.settlement
    await storage.writeManifest(manifest)
    const recovered = new SubagentService(fixture.serviceOptions)
    try {
      await recovered.initialize()
      assert.equal(fixture.settlements.length, 1, '初始化不触发终态回调')
      assert.equal(fixture.modelCalls.length, 2, '初始化不请求模型')
      const pending = []
      for await (const item of recovered.pendingSettlements(fixture.parentJournal)) pending.push(item)
      assert.equal(pending.length, 2)
      assert.equal(pending[0]?.outcome, 'completed')
      assert.equal(pending[0]?.resultText, '完整结果')
      assert.equal(pending[1]?.outcome, 'aborted')
      assert.match(pending[1]?.resultText ?? '', /本次留下的半段/)
      assert.doesNotMatch(pending[1]?.resultText ?? '', /完整结果/)
      for (const item of pending) await recovered.markSettlementDelivered(item, 'receiving-turn')
      assert.equal((await recovered.pendingSettlements(fixture.parentJournal).next()).done, true)
    } finally { await recovered.close() }
  })

  it('send 成功后原步骤被停止，追加消息仍能在下一次显式继续时读取', async () => {
    const started = deferred<void>()
    const requests: string[] = []
    const fixture = await createFixture([], async (index, call) => {
      requests.push(JSON.stringify(call.prompt))
      if (index !== 0) return finalStream('已处理追加要求。')
      started.resolve()
      return heldText(call.abortSignal!, ['尚未完成'])
    })
    const [tool] = fixture.service.createTools(fixture.runtime, fixture.parentJournal, fixture.projectDir)
    const ctx = fixture.toolContext('parent', 'control')
    const id = idFrom((await tool!.execute({ action: 'spawn', name: 'explore', description: '调查', prompt: '开始' }, ctx)).data)
    await started.promise
    assert.equal((await tool!.execute({ action: 'send', subagent_id: id, prompt: '检查第二条证据' }, ctx)).isError, false)
    await tool!.execute({ action: 'stop', subagent_id: id }, ctx)
    const journal = await new SubagentStorage(fixture.sessionsRoot).open(fixture.parentJournal.sessionId, id)
    assert.deepEqual(journal.pendingUserInputs.map(item => item.text), ['检查第二条证据'])
    assert.equal(requests.length, 1)
    await tool!.execute({ action: 'send', subagent_id: id, prompt: '现在只总结已知信息' }, ctx)
    await fixture.waitForSettlements(2)
    assert.equal(requests.length, 2)
    assert.match(requests[1]!, /检查第二条证据.*现在只总结已知信息/s)
    const reopened = await new SubagentStorage(fixture.sessionsRoot).open(fixture.parentJournal.sessionId, id)
    assert.equal(reopened.pendingUserInputs.length, 0)
    const delivered = reopened.initialViewEvents.flatMap(event =>
      event.type === 'user-message' && event.text === '检查第二条证据' ? [event.startsTurn] : [])
    assert.deepEqual(delivered, [false])
  })

  it('子代理停止时，较早的可恢复诊断不成为中断结果', async t => {
    const started = deferred<void>()
    const warnings: string[] = []
    const f = await createFixture([], async (_index, call) => {
      started.resolve()
      return heldText(call.abortSignal!, ['调查到一半'])
    }, undefined, { onEvent: ({ event }) => { if (event.type === 'error') warnings.push(event.message) } })
    t.mock.method(f.serviceOptions.skills, 'snapshot', async () => { throw new Error('临时目录读取失败') })
    const [tool] = f.service.createTools(f.runtime, f.parentJournal, f.projectDir)
    const ctx = f.toolContext('parent', 'control')
    const id = idFrom((await tool!.execute({ action: 'spawn', name: 'explore', description: '调查', prompt: '开始' }, ctx)).data)
    await started.promise
    await tool!.execute({ action: 'stop', subagent_id: id }, ctx)
    assert.ok(warnings.some(text => text.includes('临时目录读取失败')))
    assert.equal(f.settlements[0]?.outcome, 'aborted')
    assert.doesNotMatch(f.settlements[0]!.resultText, /临时目录读取失败/)
  })

  it('启动期间 stop 仅报告该子代理已停止', async t => {
    const f = await createFixture([])
    const recording = deferred<void>()
    const stopped = deferred<void>()
    const record = SessionJournal.prototype.recordUserInputWithId
    t.mock.method(SessionJournal.prototype, 'recordUserInputWithId',
      async function (this: SessionJournal, ...args: Parameters<typeof record>) {
        recording.resolve()
        await stopped.promise
        return record.call(this, ...args)
      })
    const abort = AgentSession.prototype.abort
    t.mock.method(AgentSession.prototype, 'abort', function (this: AgentSession, ...args: Parameters<typeof abort>) {
      abort.call(this, ...args)
      stopped.resolve()
    })
    const [tool] = f.service.createTools(f.runtime, f.parentJournal, f.projectDir)
    const ctx = f.toolContext('parent', 'control')
    const id = idFrom((await tool!.execute({ action: 'spawn', name: 'explore', description: '调查', prompt: '启动' }, ctx)).data)
    await recording.promise
    await tool!.execute({ action: 'stop', subagent_id: id }, ctx)
    assert.equal(f.modelCalls.length, 0)
    assert.equal(f.settlements[0]?.outcome, 'aborted')
    assert.match(f.settlements[0]!.resultText, /子代理.*停止/)
    assert.doesNotMatch(f.settlements[0]!.resultText, /父会话已停止/)
  })

  it('正常收尾已开始时 send 等待释放，再沿原实例交付一次', async t => {
    const closing = deferred<void>()
    const release = deferred<void>()
    const attempted = deferred<boolean>()
    const f = await createFixture(['首项已完成', '补充已完成'])
    const recordEnd = SessionJournal.prototype.recordTurnEnd
    let hold = true
    t.mock.method(SessionJournal.prototype, 'recordTurnEnd', async function (
      this: SessionJournal, ...args: Parameters<typeof recordEnd>
    ) {
      if (hold) {
        hold = false
        closing.resolve()
        await release.promise
      }
      return recordEnd.call(this, ...args)
    })
    const steer = AgentSession.prototype.steerSubagent
    t.mock.method(AgentSession.prototype, 'steerSubagent', async function (this: AgentSession, text: string) {
      const accepted = await steer.call(this, text)
      attempted.resolve(accepted)
      return accepted
    })
    const [tool] = f.service.createTools(f.runtime, f.parentJournal, f.projectDir)
    const ctx = f.toolContext('parent', 'control')
    const id = idFrom((await tool!.execute({ action: 'spawn', name: 'explore', description: '调查', prompt: '开始' }, ctx)).data)
    await closing.promise
    const sending = tool!.execute({ action: 'send', subagent_id: id, prompt: '收尾时的补充' }, ctx)
    try { assert.equal(await attempted.promise, false) }
    finally { release.resolve() }
    assert.equal((await sending).isError, false)
    await f.waitForSettlements(2)
    assert.equal(f.modelCalls.length, 2)
    assert.equal(JSON.stringify(f.modelCalls[1]!.prompt).match(/收尾时的补充/g)?.length, 1)
  })

  it('长结果在交付摘要中明确标记截断，子会话仍保存全文', async () => {
    const text = '证据'.repeat(75_000) + '末尾完整证据'
    const fixture = await createFixture([text])
    const [tool] = fixture.service.createTools(fixture.runtime, fixture.parentJournal, fixture.projectDir)
    const id = idFrom((await tool!.execute({ action: 'spawn', name: 'explore', description: '长调查', prompt: '完整调查' }, fixture.toolContext('parent', 'spawn'))).data)
    await fixture.waitForSettlements(1)
    const result = fixture.settlements[0]!.resultText
    assert.equal(result.length, MAX_SUBAGENT_RESULT_CHARS)
    assert.match(result, /\[内容过长，后文已截断。\]$/)
    const snapshot = await fixture.service.transcript(fixture.parentJournal.sessionId, id)
    assert.ok(snapshot.viewEvents.some(item => item.type === 'core-event'
      && item.event.type === 'text-delta' && item.event.text.endsWith('末尾完整证据')))
  })

  it('交付重启前的结果不会解除同一计划中新子代理的等待', async () => {
    const fixture = await createFixture(['旧结果', '新结果'])
    const parentId = fixture.parentJournal.sessionId
    const planId = randomUUID()
    const ctx = { ...fixture.toolContext('parent', 'spawn'), engagedPlanId: planId }
    const input = { action: 'spawn', name: 'explore', description: '核查计划', prompt: '核查' }
    const [tool] = fixture.service.createTools(fixture.runtime, fixture.parentJournal, fixture.projectDir)
    await tool!.execute(input, ctx)
    await fixture.waitForSettlements(1)
    await fixture.service.close()
    const recovered = new SubagentService(fixture.serviceOptions)
    try {
      await recovered.initialize()
      assert.equal(recovered.hasPendingPlanContinuation(parentId, planId), false)
      const [resumedTool] = recovered.createTools(fixture.runtime, fixture.parentJournal, fixture.projectDir)
      await resumedTool!.execute(input, ctx)
      await fixture.waitForSettlements(2)
      assert.equal(recovered.hasPendingPlanContinuation(parentId, planId), true)
      await recovered.markSettlementDelivered(fixture.settlements[0]!, 'receiving-turn')
      assert.equal(recovered.hasPendingPlanContinuation(parentId, planId), true)
      await recovered.markSettlementDelivered(fixture.settlements[1]!, 'receiving-turn')
      assert.equal(recovered.hasPendingPlanContinuation(parentId, planId), false)
    } finally { await recovered.close() }
  })
})

function idFrom(text: string): string {
  const id = text.match(/[0-9a-f-]{36}/u)?.[0]
  assert.ok(id, text)
  return id
}

function heldText(signal: AbortSignal, blocks: string[]) {
  return { stream: new ReadableStream({ start(controller) {
    for (const [index, text] of blocks.entries()) {
      const id = `part-${index}`
      controller.enqueue({ type: 'text-start', id })
      controller.enqueue({ type: 'text-delta', id, delta: text })
    }
    signal.addEventListener('abort', () => controller.error(new Error('已取消')), { once: true })
  } }) }
}
