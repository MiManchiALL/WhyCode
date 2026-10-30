import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { createCompactApplicationContextMessage, createCompactSummaryMessage } from '../prompts/compact.ts'
import { localWorkspace } from '../workspace/types.ts'
import { SessionStore } from './store.ts'

it('按完整压缩序号读取原摘要，微压缩不计数，冷恢复后仍能读取各次记录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-compaction-summary-'))
  try {
    const store = new SessionStore(root)
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const history = createCompactSummaryMessage({ historySummary: '## 1. 历史任务\n完成 A', turnPrefixSummary: null, turnId: null })
    const prefix = createCompactSummaryMessage({ historySummary: null, turnPrefixSummary: '## Progress\n- 已完成 B 的第一步', turnId: 'turn-b' })
    await journal.recordSnapshot('compact', [history, prefix,
      { role: 'assistant', content: '保留尾部，不是摘要' },
      createCompactApplicationContextMessage(['PDF 引用与当前计划，不是摘要']),
    ])
    await journal.recordViewEvents([{ type: 'core-event', event: {
      type: 'context-compacted', level: 'full', preTokens: 60_000, postTokens: 20_000,
    } }])
    await journal.recordSnapshot('compact', [history, prefix])
    await journal.recordViewEvents([{ type: 'core-event', event: {
      type: 'context-compacted', level: 'micro', preTokens: 40_000, postTokens: 35_000,
    } }])
    await journal.recordSnapshot('compact', [createCompactSummaryMessage({
      historySummary: '## 1. 历史任务\nA、B 均已完成', turnPrefixSummary: null, turnId: null,
    })])
    await journal.recordViewEvents([{ type: 'core-event', event: {
      type: 'context-compacted', level: 'full', preTokens: 45_000, postTokens: 12_000,
    } }])

    const reopened = await store.open(journal.sessionId)
    const first = await reopened.readCompactionSummary(1)
    assert.equal(first.historySummary, '## 1. 历史任务\n完成 A')
    assert.equal(first.turnPrefixSummary, '## Progress\n- 已完成 B 的第一步')
    assert.equal(first.preTokens, 60_000)
    assert.equal(first.postTokens, 20_000)
    assert.equal(first.index, 1)
    assert.ok(Number.isFinite(Date.parse(first.timestamp)))
    assert.doesNotMatch(JSON.stringify(first), /保留尾部|PDF 引用与当前计划/)
    const second = await reopened.readCompactionSummary(2)
    assert.equal(second.historySummary, '## 1. 历史任务\nA、B 均已完成')
    assert.equal(second.turnPrefixSummary, null)
    assert.equal(second.preTokens, 45_000)
    assert.equal(second.index, 2)
    await assert.rejects(reopened.readCompactionSummary(3), /找不到该次完整压缩记录/)
    assert.deepEqual(await reopened.readCompactionSummary(1), first)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('只有快照而没有完整压缩成功事件时不提供成功摘要', async () => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-compaction-unconfirmed-'))
  try {
    const store = new SessionStore(root)
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await journal.recordSnapshot('compact', [createCompactSummaryMessage({
      historySummary: '尚未发布成功事件', turnPrefixSummary: null, turnId: null,
    })])
    await assert.rejects(journal.readCompactionSummary(1), /找不到该次完整压缩记录/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
