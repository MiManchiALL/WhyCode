import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { APICallError, type ModelMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { withUserTurn } from '../context/user-turn.ts'
import type { CoreEvent } from '../events.ts'
import { createCompactSummaryMessage, parseCompactSummaryMessage } from '../prompts/compact.ts'
import { getModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import { localWorkspace } from '../workspace/types.ts'
import { AgentSession } from './session.ts'

describe('手动压缩 PTL 的会话提交与恢复', () => {
  for (const outcome of ['success', 'save-failure', 'summary-failure'] as const) {
    it(outcome === 'success' ? '退避后 H/U/P/T 整体提交并可冷恢复'
      : outcome === 'save-failure' ? '候选保存失败时不发布成功或更换活动历史'
        : 'H 成功但 P 失败时不保存半份摘要', async t => {
      const directory = await mkdtemp(join(tmpdir(), 'whycode-compact-retry-'))
      t.after(() => rm(directory, { recursive: true, force: true }))
      const store = new SessionStore(directory)
      const journal = await store.create({ workspace: localWorkspace(null), modelId: 'openai:gpt-5.6-sol' })
      let calls = 0
      const model = new MockLanguageModelV4({ doGenerate: async () => {
        if (++calls === 1) throw new APICallError({
          message: 'prompt is too long: 130000 tokens > 128000 maximum',
          statusCode: 400, url: 'http://localhost/model', requestBodyValues: {},
        })
        return {
          content: [{ type: 'text', text: calls === 2 ? '<summary>新 H</summary>'
            : outcome === 'summary-failure' ? '<summary>未完成 P' : '已整理：<summary>新 P_B</summary>' }],
          finishReason: { unified: 'stop', raw: undefined }, warnings: [],
          usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 10, text: 10, reasoning: undefined } },
        }
      } })
      const events: CoreEvent[] = []
      const entry = getModelEntry('openai:gpt-5.6-sol')
      const session = new AgentSession({
        model: { ...entry, capabilities: { ...entry.capabilities, contextWindow: 128_000, maxOutput: 20_000 }, create: () => model },
        providerConfig: { apiKey: 'test' }, promptContext: { projectDir: directory, osPlatform: 'win32' },
        sessionRecorder: journal, emit: event => events.push(event), requestApproval: async () => ({ approved: true }),
      })
      t.after(() => session.dispose())
      const batch: ModelMessage[] = [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'read', toolName: 'ReadFile', input: { path: 'example.txt' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'read', toolName: 'ReadFile',
          output: { type: 'text', value: '保持完整的工具结果：' + 'x'.repeat(12_000) } }] },
      ]
      const history: ModelMessage[] = [
        createCompactSummaryMessage({ historySummary: '旧 H', turnPrefixSummary: null, turnId: null }),
        withUserTurn({ role: 'user', content: '任务 A' }, 'A', true),
        createCompactSummaryMessage({ historySummary: null, turnPrefixSummary: '旧 P_A', turnId: 'A' }),
        { role: 'assistant', content: 'A 已完成' },
        withUserTurn({ role: 'user', content: '完整任务 B' }, 'B', true),
        { role: 'assistant', content: 'B 前期工作' }, ...batch,
      ]
      await journal.recordSnapshot('rollback', history)
      session.restoreMessageSnapshot(history)
      const before = session.captureMessageSnapshot()
      const recordSnapshot = journal.recordSnapshot.bind(journal)
      let commits = 0
      journal.recordSnapshot = async (...args) => {
        commits++
        assert.deepEqual(session.captureMessageSnapshot(), before)
        assert.equal(events.some(event => event.type === 'context-compacted'), false)
        if (outcome === 'save-failure') throw new Error('快照保存失败')
        await recordSnapshot(...args)
      }

      await session.compactNow()

      assert.equal(calls, 3)
      assert.equal(session.isBusy, false)
      assert.equal(model.doStreamCalls.length, 0, '手动压缩本身不继续执行任务')
      assert.equal(events.filter(event => event.type === 'model-request-retry').length, 1)
      const current = session.captureMessageSnapshot()
      const restored = (await store.open(journal.sessionId)).initialMessages
      if (outcome === 'success') {
        assert.equal(commits, 1)
        assert.equal(events.filter(event => event.type === 'context-compacted' && event.level === 'full').length, 1)
        assert.equal(events.some(event => event.type === 'error'), false)
        const summaries = current.map(parseCompactSummaryMessage).filter(state => state !== null)
        assert.equal(summaries[0]?.historySummary, '新 H')
        assert.equal(summaries[1]?.turnPrefixSummary, '新 P_B')
        assert.equal(current.filter(message => message.content === '完整任务 B').length, 1)
        const tailStart = current.findIndex(message => message.role === 'assistant' && Array.isArray(message.content)
          && message.content.some(part => part.type === 'tool-call' && part.toolCallId === 'read'))
        assert.ok(tailStart >= 0)
        assert.deepEqual(current.slice(tailStart, tailStart + batch.length), batch)
        assert.deepEqual(restored, current)
      } else {
        assert.equal(commits, outcome === 'save-failure' ? 1 : 0)
        assert.equal(events.some(event => event.type === 'context-compacted'), false)
        assert.ok(events.some(event => event.type === 'error' && event.message.includes(
          outcome === 'save-failure' ? '快照保存失败' : '摘要为空或格式不完整')))
        assert.deepEqual(current, before)
        assert.deepEqual(restored, history)
      }
    })
  }
})
