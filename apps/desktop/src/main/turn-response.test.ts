import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { AgentSession, localWorkspace, SessionStore } from '@whycode/core'
import { conversationSections } from '../shared/conversation-sections.ts'
import { applyCoreEvent, createConversationState } from '../shared/conversation-state.ts'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { deferred, finalStream, languageModel, modelEntry } from './subagent-test-fixture.ts'

it('父轮次等待子代理、接收立即插话后只折叠到最终回复，切换和重开会话得到相同结果', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-turn-response-'))
  const store = new SessionStore(root)
  const workspace = localWorkspace(root)
  const journal = await store.create({ workspace, modelId: 'test:subagent' })
  const progress = [['已核查第一项。', '等待其余结果。'], ['补充要求已收到。', '仍在核查。']]
  const answer = '核查完成。\n\n| 项目 | 结果 |\n| --- | --- |\n| 第一项 | 通过 |'
  const replies = [...progress, answer]
  const commits = progress.map(() => deferred<void>())
  let step = 0
  let live = createConversationState()
  let turnId = ''
  const runtime = new DesktopSessionRuntime({
    workspace, modelId: 'test:subagent',
    emit: (_runtime, event, timestamp) => {
      live = applyCoreEvent(live, event, timestamp)
      if (event.type === 'turn-start') turnId = event.turnId
      if (event.type === 'step-committed') commits[step++]?.resolve()
    },
  })
  runtime.journal = journal
  const child = { subagentId: randomUUID(), activationId: randomUUID(), description: '核查资料' }
  let delivered = false
  const session = new AgentSession({
    model: modelEntry(languageModel(() => finalStream(replies.shift() ?? assert.fail('意外的模型请求')))),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: root, osPlatform: 'win32' },
    emit: event => runtime.emit(event),
    sessionRecorder: journal,
    getSubagentTurnState: async parentTurnId => ({
      parentTurnId,
      activations: [{
        ...child,
        ...(delivered ? { outcome: 'completed', settlement: 'delivered' } as const : {}),
      }],
    }),
    requestApproval: async () => ({ approved: false }),
  })
  t.after(async () => {
    session.abort()
    await session.waitUntilIdle()
    await session.dispose()
    await runtime.timeline.flush()
    await rm(root, { recursive: true, force: true })
  })
  const inputId = randomUUID()
  await journal.recordUserInputWithId(inputId, '核查资料', true)
  runtime.beginWork()
  runtime.emit({ type: 'user-message-accepted', inputId, startsTurn: true, text: '核查资料' }, false)
  const running = session.handleUserMessage('核查资料', false, [], inputId)

  for (const [index, commit] of commits.entries()) {
    await commit.promise
    const snapshot = await runtime.timeline.conversationAt(journal, () => undefined)
    for (const view of [live, snapshot.state]) {
      const rows = conversationSections(view.blocks, runtime.workStartedAt)
      assert.ok(rows.every(row => row.kind === 'block'))
      assert.deepEqual(view.blocks.filter(block => block.kind === 'text').map(block => block.text), progress.slice(0, index + 1).flat())
    }
    if (index === 0) session.handleUserMessage('请再比较两者的结果', true)
  }
  session.handleSubagentSettlement({
    ...child, parentSessionId: journal.sessionId, parentTurnId: turnId, outcome: 'completed', resultText: '核查通过',
  }, () => { delivered = true })
  assert.equal(await running, 'completed')
  await runtime.timeline.flush()
  const reopened = await store.open(journal.sessionId)
  for (const view of [live, createConversationState(reopened.initialViewEvents)]) {
    const section = conversationSections(view.blocks).at(-1)
    assert.ok(section?.kind === 'completed-work')
    assert.equal(view.expanded.has(section.id), false)
    assert.deepEqual(section.activityBlocks.filter(block => block.kind === 'text').map(block => block.text), progress.flat())
    assert.deepEqual(section.finalBlocks.filter(block => block.kind === 'text').map(block => block.text), [answer])
  }
})
