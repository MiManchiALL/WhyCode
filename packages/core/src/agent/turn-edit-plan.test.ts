import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore, type SessionJournal } from '../session/store.ts'
import { toViewEvent, type ViewEvent } from '../session/view-events.ts'
import { emptyTaskPlanState, type TaskPlan } from '../tasks/types.ts'
import { localWorkspace } from '../workspace/types.ts'
import { AgentSession } from './session.ts'

function plan(status: TaskPlan['status']): TaskPlan {
  return {
    id: randomUUID(), goal: '上一轮任务', status, revision: 3,
    items: ['work', 'verification'].map((kind, index) => ({
      id: `T${index + 1}`, kind: kind as 'work' | 'verification', outcome: `里程碑 ${index + 1}`,
      status: status === 'completed' ? 'completed' : 'pending',
      evidence: status === 'completed' ? ['已验证'] : [],
    })),
  }
}

async function recordTurn(journal: SessionJournal, turnId: string, displayPlan?: TaskPlan) {
  const inputId = randomUUID()
  await journal.recordUserInputWithId(inputId, turnId, true)
  await journal.recordTurnStart(turnId, [{ role: 'user', content: turnId }], undefined, [], undefined, inputId)
  await journal.recordViewEvents([{ type: 'core-event', event: { type: 'turn-start', turnId } }])
  await journal.recordStep(turnId, [{ role: 'assistant', content: `${turnId} 已处理` }], displayPlan
    ? { ...emptyTaskPlanState(), version: 3, activePlan: displayPlan.status === 'active' ? displayPlan : null }
    : undefined)
  if (displayPlan) await journal.recordViewEvents([{ type: 'core-event', event: { type: 'task-plan-updated', plan: displayPlan } }])
  await journal.recordTurnEnd(turnId, 'completed')
}

function displayedPlan(events: readonly ViewEvent[]): TaskPlan | null {
  let result: TaskPlan | null = null
  for (const entry of events) {
    if (entry.type !== 'core-event') continue
    const event = entry.event
    if (event.type === 'task-plan-updated' || event.type === 'task-plan-restored') result = event.plan
    if (event.type === 'user-message-edited') result = event.taskPlan
    if (event.type === 'checkpoint-restored' && event.ok && event.scope === 'files-and-chat'
      && event.taskPlan !== undefined) result = event.taskPlan
  }
  return result
}

for (const previousStatus of ['completed', 'ended', 'active', 'cleared', null] as const) {
  for (const replacesPlan of [false, true]) {
    it(`编辑后恢复保留历史的计划：此前=${previousStatus}，被编辑轮次有新计划=${replacesPlan}`, async t => {
      const root = await mkdtemp(join(await realpath(tmpdir()), 'whycode-edit-plan-'))
      t.after(() => rm(root, { recursive: true, force: true }))
      const store = new SessionStore(join(root, 'sessions'))
      const journal = await store.create({ workspace: localWorkspace(root), modelId: 'test:plan-edit' })
      const previous = previousStatus && previousStatus !== 'cleared' ? plan(previousStatus) : null
      if (previous) await recordTurn(journal, 'turn-a', previous)
      if (previousStatus === 'cleared') {
        await recordTurn(journal, 'discarded-turn', plan('completed'))
        await journal.recordSnapshot('rollback', [], undefined, emptyTaskPlanState())
        await journal.recordViewEvents([{ type: 'core-event', event: {
          type: 'checkpoint-restored', toolUseId: 'discarded-tool', turnId: 'discarded-turn',
          scope: 'files-and-chat', ok: true, taskPlan: null,
        } }])
      }
      await recordTurn(journal, 'turn-b', replacesPlan ? plan('completed') : undefined)

      const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [
        { type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: '普通回复' },
        { type: 'text-end', id: 'answer' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        } },
      ] }) }) })
      const entry: ModelEntry = {
        id: 'test:plan-edit', displayName: 'Plan edit test', provider: 'openai', protocol: 'openai-responses',
        capabilities: { supportsNativeTools: true, supportsImageInput: false, reasoningExposure: 'none',
          structuredOutput: 'tool-based', promptCaching: 'none', contextWindow: 100_000, maxOutput: 4_000 },
        create: () => model,
      }
      const events: CoreEvent[] = []
      const session = new AgentSession({
        model: entry, providerConfig: { apiKey: 'test' }, sessionRecorder: journal,
        promptContext: { projectDir: root, osPlatform: process.platform },
        requestApproval: async () => ({ approved: true }), emit: event => events.push(event),
      })
      t.after(() => session.dispose())
      let target = 'turn-b'
      for (let edit = 0; edit < 2; edit++) {
        events.length = 0
        const prepared = await session.prepareLatestTurnEdit(target, `重发 ${edit}`)
        prepared.accept()
        const accepted = events.find(event => event.type === 'user-message-edited')
        assert.ok(accepted?.type === 'user-message-edited')
        assert.deepEqual(accepted.taskPlan, previous, '实时事件必须恢复该轮开始前的展示')
        assert.deepEqual(displayedPlan(journal.initialViewEvents), previous, '当前会话快照一致')
        assert.deepEqual(displayedPlan((await store.open(journal.sessionId)).initialViewEvents), previous, '编辑提交后尚未响应也能冷恢复')
        assert.deepEqual(session.captureTaskStateSnapshot()?.activePlan, previous?.status === 'active' ? previous : null)

        assert.equal(await prepared.startMain(), 'completed')
        await journal.recordViewEvents(events.flatMap(event => toViewEvent(event) ?? []))
        assert.deepEqual(displayedPlan((await store.open(journal.sessionId)).initialViewEvents), previous, '普通回复结束后展示不变')
        const started = events.find(event => event.type === 'turn-start')
        assert.ok(started?.type === 'turn-start')
        target = started.turnId
      }
    })
  }
}
