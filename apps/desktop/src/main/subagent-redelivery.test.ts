import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { it } from 'node:test'
import { AgentSession, SessionStore } from '@whycode/core'
import { createFixture, finalStream, languageModel, modelEntry } from './subagent-test-fixture.ts'

it('编辑重发重新交付较早回合的结果，撤回本轮委派，冷读取和再次编辑遵循同一边界', async () => {
  const f = await createFixture(['上一轮留下的证据', '被编辑回合自身的证据'])
  const journal = f.parentJournal
  const store = new SessionStore(f.sessionsRoot)
  const [tool] = f.service.createTools(f.runtime, journal, f.projectDir)
  const spawn = (parentTurnId: string) => tool!.execute({
    action: 'spawn', name: 'explore', description: '调查', prompt: '核查证据',
  }, f.toolContext(parentTurnId, randomUUID()))
  await spawn('earlier-turn')
  await f.waitForSettlements(1)

  const requests: string[] = []
  let turnId = ''
  const parent = new AgentSession({
    model: modelEntry(languageModel(async (call) => {
      requests.push(JSON.stringify(call.prompt))
      if (requests.length === 1) {
        await spawn(turnId)
        await f.waitForSettlements(2)
        parent.handleSubagentSettlement(f.settlements[1]!)
      }
      return finalStream('已处理请求。')
    })),
    providerConfig: { apiKey: 'test' }, promptContext: { projectDir: f.projectDir, osPlatform: 'win32' },
    sessionRecorder: journal, requestApproval: async () => ({ approved: false }),
    pendingSubagentSettlements: () => f.service.pendingSettlements(journal),
    onSubagentSettlementDelivered: (item, receiver) => f.service.markSettlementDelivered(item, receiver),
    emit(event) {
      if (event.type === 'turn-start') turnId = event.turnId
      f.runtime.emit(event)
    },
  })
  f.runtime.session = parent
  const id = randomUUID()
  await journal.recordUserInputWithId(id, '汇总', true)
  assert.equal(await parent.handleUserMessage('汇总', false, [], id), 'completed')
  await f.runtime.timeline.flush()
  assert.match(requests.at(-1)!, /上一轮留下的证据/)
  assert.match(requests.at(-1)!, /被编辑回合自身的证据/)

  for (const text of ['重新汇总', '再次编辑']) {
    const prepared = await parent.prepareLatestTurnEdit(turnId, text)
    const cold = await store.open(journal.sessionId)
    const pending = []
    for await (const item of f.service.pendingSettlements(cold)) pending.push(item.resultText)
    assert.deepEqual(pending, ['上一轮留下的证据'])
    assert.equal(await prepared.startMain(), 'completed')
    await f.runtime.timeline.flush()
    assert.match(requests.at(-1)!, /上一轮留下的证据/)
    assert.doesNotMatch(requests.at(-1)!, /被编辑回合自身的证据/)
    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.initialMessages.filter(message =>
      typeof message.content === 'string' && message.content.includes('上一轮留下的证据')).length, 1)
  }
  await journal.recordSnapshot('compact', [{ role: 'assistant', content: '历史调查已汇总。' }])
  const compacted = await store.open(journal.sessionId)
  assert.equal((await f.service.pendingSettlements(compacted).next()).done, true)
})
