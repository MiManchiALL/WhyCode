import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import { createCompactSummaryMessage } from '../prompts/compact.ts'
import { SessionStore } from '../session/store.ts'
import { localWorkspace } from '../workspace/types.ts'
import { prepareCompaction } from './compact-boundary.ts'
import { carryRecentPdfTurns, recentUserPdfIds, recentPdfUserTurns, userTurn, withUserTurn, withoutConversationMetadata } from './user-turn.ts'

describe('正式 turn 身份与压缩后的附件窗口', () => {
  it('插话不推进窗口，重复固定用户原文和重建摘要也不重排上传时间', () => {
    const pdfA = '11111111-1111-4111-8111-111111111111'
    const pdfB = '22222222-2222-4222-8222-222222222222'
    const messages = [root('A', [pdfA]), root('B'), withUserTurn({ role: 'user', content: '插话附件' }, 'B', false, [pdfB]), root('C')]
    const summary = carryRecentPdfTurns(createCompactSummaryMessage({ historySummary: 'H', turnPrefixSummary: null, turnId: null }), messages)
    const compacted = [summary, messages[3]!]
    assert.deepEqual(recentUserPdfIds(compacted), new Set([pdfA, pdfB]))
    compacted.push(root('D'))
    assert.deepEqual(recentPdfUserTurns(compacted).map(turn => turn.id), ['B', 'C', 'D'])
    assert.deepEqual(recentUserPdfIds(compacted), new Set([pdfB]))
    assert.equal(JSON.stringify(withoutConversationMetadata(compacted)).includes('whycode"'), false)
  })

  it('compact snapshot 冷恢复和 Fork 保留摘要所属 turn、原文与窗口，不复活旧回滚锚点', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'whycode-compact-turn-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const store = new SessionStore(directory)
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:compact' })
    const user = root('A')
    await journal.recordTurnStart('A', [user])
    const history = carryRecentPdfTurns(createCompactSummaryMessage({ historySummary: 'H', turnPrefixSummary: null, turnId: null }), [root('old'), user])
    const prefix = createCompactSummaryMessage({ historySummary: null, turnPrefixSummary: 'P_A', turnId: 'A' })
    const messages = [history, user, prefix, { role: 'assistant' as const, content: '压缩后的进展' }]
    await journal.recordSnapshot('compact', messages, 'A')
    await journal.recordStep('A', [{ role: 'assistant', content: '最终结果' }])
    await journal.recordTurnEnd('A', 'completed')
    await journal.recordViewEvents([{ type: 'core-event', event: { type: 'work-finished', durationMs: 1,
      outcome: 'completed', forkTurnId: 'A' } }])
    const cold = await store.open(journal.sessionId)
    const fork = await store.fork(cold, 'A')
    for (const restored of [cold, fork, await store.open(fork.sessionId)]) {
      assert.equal(restored.messagesBeforeTurn('A'), null)
      assert.equal(restored.initialMessages.filter(message => userTurn(message)?.startsTurn).length, 1)
      assert.equal(userTurn(restored.initialMessages[1]!)?.id, 'A')
      assert.deepEqual(recentPdfUserTurns(restored.initialMessages).map(turn => turn.id), ['old', 'A'])
      const prepared = prepareCompaction([...restored.initialMessages, { role: 'assistant', content: 'x'.repeat(75_000) }], 17_280)!
      assert.equal(prepared.historySource, null)
      assert.equal(prepared.turnPrefixSource?.previousSummary, 'P_A')
      assert.equal(prepared.pinnedUser?.content, 'A')
    }
    await cold.recordTurnStart('B', [root('B')])
    await cold.recordStep('B', [{ role: 'assistant', content: 'B 的结果' }])
    await cold.recordTurnEnd('B', 'completed')
    const beforeB = cold.messagesBeforeTurn('B')!
    await cold.recordSnapshot('rollback', beforeB)
    assert.deepEqual((await store.open(cold.sessionId)).initialMessages, beforeB)
  })
})

function root(id: string, pdfIds: string[] = []): ModelMessage {
  return withUserTurn({ role: 'user', content: id }, id, true, pdfIds)
}
