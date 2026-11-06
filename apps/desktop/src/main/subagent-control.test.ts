import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { buildTool, MAX_SUBAGENT_RESULT_CHARS } from '@whycode/core'
import { createFixture, deferred, finalStream, toolStream } from './subagent-test-fixture.ts'
import { SubagentService } from './subagent-service.ts'
import { SubagentStorage } from './subagent-storage.ts'

describe('子代理控制与被动恢复', { timeout: 30_000 }, () => {
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
      for await (const item of recovered.pendingSettlements(fixture.parentJournal.sessionId)) pending.push(item)
      assert.equal(pending.length, 2)
      assert.equal(pending[0]?.outcome, 'completed')
      assert.equal(pending[0]?.resultText, '完整结果')
      assert.equal(pending[1]?.outcome, 'aborted')
      assert.match(pending[1]?.resultText ?? '', /本次留下的半段/)
      assert.doesNotMatch(pending[1]?.resultText ?? '', /完整结果/)
      for (const item of pending) await recovered.markSettlementDelivered(item)
      assert.equal((await recovered.pendingSettlements(fixture.parentJournal.sessionId).next()).done, true)
    } finally { await recovered.close() }
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
      await recovered.markSettlementDelivered(fixture.settlements[0]!)
      assert.equal(recovered.hasPendingPlanContinuation(parentId, planId), true)
      await recovered.markSettlementDelivered(fixture.settlements[1]!)
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
