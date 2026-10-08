import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import type { ModelMessage } from 'ai'
import { emptyTaskPlanState } from '../tasks/types.ts'
import { localWorkspace } from '../workspace/types.ts'
import { buildLoadedSession, parseTranscript, SessionCorruptError } from './chain.ts'
import { SessionStore } from './store.ts'
import { SESSION_SCHEMA_VERSION, sessionEntrySchema } from './types.ts'

describe('快照回合边界', () => {
  it('长会话的快照正文只存一份，恢复和连续回滚保持精确前缀', async (t) => {
    const { store, journal, transcript } = await setup(t)
    const history: ModelMessage[] = []
    for (let index = 0; index < 24; index++) {
      const user: ModelMessage = { role: 'user', content: `问题 ${index}` }
      const answer: ModelMessage = { role: 'assistant', content: `${index}:${'长回复'.repeat(4_000)}` }
      await journal.recordTurnStart(`turn-${index}`, [user])
      await journal.recordStep(`turn-${index}`, [answer])
      await journal.recordTurnEnd(`turn-${index}`, 'completed')
      history.push(user, answer)
    }
    await journal.recordSnapshot('rollback', history)
    const entries = parseTranscript(await readFile(transcript, 'utf8'))
    const snapshot = entries.at(-1)!
    assert.equal(snapshot.type, 'snapshot')
    if (snapshot.type !== 'snapshot') throw new Error('缺少快照')
    assert.equal(snapshot.turnStarts.length, 24)
    assert.ok(JSON.stringify(snapshot).length < JSON.stringify(history).length + 16_384)

    const loaded = buildLoadedSession(entries)
    // 约束历史对象的保留量，防止恢复时重新展开出每个回合各一份深副本。
    const retained = new Set(loaded.messages)
    for (const [turnId, messages] of loaded.turnStartMessages) {
      const index = Number(turnId.slice('turn-'.length))
      assert.deepEqual(messages, history.slice(0, index * 2))
      for (const message of messages) retained.add(message)
    }
    assert.equal(retained.size, history.length)

    const cold = await store.open(journal.sessionId)
    for (const index of [18, 9, 1]) {
      const prefix = history.slice(0, index * 2)
      assert.deepEqual(cold.messagesBeforeTurn(`turn-${index}`), prefix)
      await cold.recordSnapshot('rollback', prefix)
      const reopened = await store.open(journal.sessionId)
      assert.deepEqual(reopened.initialMessages, prefix)
      assert.equal(reopened.messagesBeforeTurn(`turn-${index}`), null)
      assert.deepEqual(reopened.messagesBeforeTurn(`turn-${index - 1}`), prefix.slice(0, -2))
    }
    await cold.recordSnapshot('compact', [{ role: 'user', content: '压缩摘要' }])
    assert.equal((await store.open(journal.sessionId)).messagesBeforeTurn('turn-0'), null)
  })

  it('共享历史仍隔离写入参数、读取结果和回滚参数的后续修改', async (t) => {
    const { store, journal } = await setup(t)
    const input: ModelMessage = { role: 'user', content: '原问题' }
    const pendingStart = journal.recordTurnStart('first', [input])
    input.content = '提交后修改参数'
    await pendingStart
    const part = { type: 'text' as const, text: '原回答', providerOptions: { test: { stamp: 1 } } }
    const pendingStep = journal.recordStep('first', [{ role: 'assistant', content: [part] }])
    part.text = '外部改写回答'
    part.providerOptions.test.stamp = 2
    await pendingStep
    await journal.recordTurnEnd('first', 'completed')
    const expected = journal.initialMessages
    assert.deepEqual(expected, [
      { role: 'user', content: '原问题' },
      { role: 'assistant', content: [{ type: 'text', text: '原回答', providerOptions: { test: { stamp: 1 } } }] },
    ])

    await journal.recordTurnStart('second', [{ role: 'user', content: '继续' }])
    const exposed = journal.initialMessages
    exposed[0]!.content = '修改读取结果'
    const boundary = journal.messagesBeforeTurn('second')!
    boundary[0]!.content = '修改回滚读取结果'
    assert.deepEqual(journal.messagesBeforeTurn('second'), expected)

    const snapshot = [...expected]
    const pendingSnapshot = journal.recordSnapshot('rollback', snapshot)
    snapshot[0]!.content = '修改提交中的快照参数'
    await pendingSnapshot
    const cold = await store.open(journal.sessionId)
    assert.equal(journal.initialMessages[0]!.content, '原问题')
    assert.deepEqual(cold.initialMessages, journal.initialMessages)
    assert.deepEqual(cold.messagesBeforeTurn('first'), [])
  })

  it('拒绝越界、重复、压缩后残留的锚点和旧 schema', async (t) => {
    const { journal, transcript } = await setup(t)
    await journal.recordTurnStart('first', [{ role: 'user', content: '问题' }])
    await journal.recordStep('first', [{ role: 'assistant', content: '回答' }])
    await journal.recordTurnEnd('first', 'completed')
    await journal.recordSnapshot('rollback', [...journal.initialMessages])
    const entries = parseTranscript(await readFile(transcript, 'utf8'))
    const snapshot = entries.at(-1)!
    if (snapshot.type !== 'snapshot') throw new Error('缺少快照')
    const anchor = snapshot.turnStarts[0]!
    for (const messageCount of [-1, 0.5, snapshot.messages.length, Number.MAX_SAFE_INTEGER]) {
      assert.equal(sessionEntrySchema.safeParse({
        ...snapshot, turnStarts: [{ ...anchor, messageCount }],
      }).success, false)
    }
    for (const invalid of [
      { ...snapshot, turnStarts: [anchor, anchor] },
      { ...snapshot, reason: 'compact' },
      { ...snapshot, schemaVersion: SESSION_SCHEMA_VERSION - 1 },
      { ...snapshot, turnStarts: undefined, turnStartMessages: [] },
    ]) assert.equal(sessionEntrySchema.safeParse(invalid).success, false)

    const missingTurn = sessionEntrySchema.parse({
      ...snapshot, turnStarts: [{ turnId: 'missing', messageCount: 0, taskState: emptyTaskPlanState() }],
    })
    assert.throws(() => buildLoadedSession([...entries.slice(0, -1), missingTurn]), SessionCorruptError)
  })
})

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-snapshot-boundaries-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new SessionStore(root)
  const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:boundaries' })
  return { store, journal, transcript: join(root, journal.sessionId, 'transcript.jsonl') }
}
