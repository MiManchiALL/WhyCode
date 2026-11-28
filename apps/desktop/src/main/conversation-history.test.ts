import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { describe, it } from 'node:test'
import type { ViewEvent } from '@whycode/core'
import { ConversationHistoryProjection } from './conversation-history.ts'
import { conversationHistorySnapshot, conversationHistoryWindow } from '../shared/conversation-window.ts'
import { applyCoreEvent, createConversationState } from '../shared/conversation-state.ts'
import { restoreConversationSnapshot } from '../shared/conversation-history.ts'
import { conversationNavigationEntries } from '../shared/conversation-navigation.ts'
import { conversationSections } from '../shared/conversation-sections.ts'

const core = (event: Extract<ViewEvent, { type: 'core-event' }>['event']): ViewEvent => ({ type: 'core-event', event })
function work(index: number): ViewEvent[] {
  return [
    { type: 'user-message', text: `问题 ${index}`, startsTurn: true, inputId: `input-${index}` },
    core({ type: 'turn-start', turnId: `turn-${index}` }),
    core({ type: 'tool-start', toolUseId: `tool-${index}`, toolName: 'ReadFile', input: { path: 'README.md' } }),
    core({ type: 'tool-end', toolUseId: `tool-${index}`, result: `内容 ${index}`, isError: false }),
    core({ type: 'text-delta', text: `回答 ${index}` }),
    core({ type: 'work-finished', durationMs: 1_000, outcome: 'completed', forkTurnId: `turn-${index}` }),
  ]
}
function works(count: number): ViewEvent[] { return Array.from({ length: count }, (_, i) => work(i)).flat() }

describe('会话历史分页', () => {
  it('最近六组和轻量定位轨覆盖全部输入，向前向后读取皆有界', () => {
    const state = createConversationState(works(65))
    const tail = conversationHistorySnapshot(state)
    const users = (page: typeof tail.view) => page.blocks.filter(b => b.kind === 'user')
    assert.equal(users(tail.view).length, 6)
    assert.deepEqual([...tail.earlierEntries, ...conversationNavigationEntries(conversationSections(tail.view.blocks))],
      conversationNavigationEntries(conversationSections(state.blocks)))
    let page = conversationHistoryWindow(state)
    const seen = new Set<string>()
    while (true) {
      page.view.blocks.forEach(b => seen.add(b.id))
      if (page.before === null) break
      const older = conversationHistoryWindow(state, { kind: 'older', cursor: page.before })
      assert.ok((older.before ?? 0) < page.before)
      assert.ok(users(older.view).length <= 18)
      assert.ok(older.view.blocks.some(b => b.id === page.view.blocks[0]!.id))
      page = older
    }
    assert.equal(seen.size, state.blocks.length)
    while (page.after !== null) {
      const newer = conversationHistoryWindow(state, { kind: 'newer', cursor: page.after })
      assert.ok((newer.after ?? state.blocks.length) > page.after)
      assert.ok(users(newer.view).length <= 18)
      assert.ok(newer.view.blocks.some(b => b.id === page.view.blocks.at(-1)!.id))
      page = newer
    }
    assert.equal(page.view.blocks.at(-1), state.blocks.at(-1))
  })

  it('轨道、阅读锚点和正文段 ID 一次直达目标，窗口和实时尾部分开', () => {
    const state = createConversationState(works(250))
    const target = state.blocks[40]!
    const around = conversationHistoryWindow(state, { kind: 'around', id: target.id })
    assert.ok(around.view.blocks.includes(target))
    assert.equal(around.view.blocks.filter(b => b.kind === 'user').length, 6)
    assert.deepEqual(conversationHistorySnapshot(state, target.id).reading, around)
    assert.ok(conversationHistorySnapshot(state, 'work-input-10').reading)
    assert.equal(conversationHistorySnapshot(state, '已回滚的锚点').reading, undefined)
    assert.throws(() => conversationHistoryWindow(state, { kind: 'around', id: '已删除' }), /定位/)
  })

  it('远处的回滚同时更新定位轨、窗口边界和最新正文', () => {
    const state = createConversationState(works(45))
    const restored = applyCoreEvent(state, { type: 'checkpoint-restored', toolUseId: 'tool-10',
      turnId: 'turn-10', scope: 'files-and-chat', ok: true })
    const history = conversationHistorySnapshot(restored)
    assert.equal(history.earlierEntries.length, 4)
    assert.equal(history.view.blocks.some(b => b.kind === 'user' && b.turnId === 'turn-44'), false)
    assert.throws(() => conversationHistoryWindow(restored, { kind: 'around', id: state.blocks.at(-1)!.id }))
  })

  it('未显示的压缩和检查点仍由完整投影决定序号和有效边界', () => {
    const compact = core({ type: 'context-compacted', level: 'full', preTokens: 40_000, postTokens: 10_000 })
    const events = work(-1)
    events.splice(4, 0, core({ type: 'checkpoint-created', toolUseId: 'tool--1', hash: 'hash', coverage: 'complete' }))
    const state = createConversationState([...events, compact, ...works(25), compact, core({
      type: 'checkpoint-restored', turnId: 'turn--1', toolUseId: 'tool--1', scope: 'files', ok: true })])
    const tail = restoreConversationSnapshot(conversationHistoryWindow(state).view)
    assert.deepEqual(tail.blocks.filter(b => b.kind === 'compaction').map(b => b.index), [2])
    assert.equal(applyCoreEvent(tail, { type: 'context-compacted', level: 'full', preTokens: 20, postTokens: 10 }).compactionCount, 3)
    const distant = conversationHistoryWindow(state, { kind: 'around', id: state.blocks[0]!.id })
    assert.equal(distant.view.fileRollbackBoundaryTurnId, 'turn--1')
    const tool = distant.view.blocks.find(b => b.kind === 'tool')
    assert.equal(tool?.kind === 'tool' && tool.call.hasCheckpoint, false)
  })

  it('一轮中的插话、工具和连续 BTW 问答保持完整分组', () => {
    const events = works(4)
    for (let turnIndex = 1; turnIndex <= 3; turnIndex++) {
      events.push(
        { type: 'user-message', text: `侧问题 ${turnIndex}`, startsTurn: false,
          btw: { conversationId: 'side', turnIndex, mode: turnIndex === 1 ? 'btw' : 'bbtw' } },
        core({ type: 'text-delta', text: `侧回答 ${turnIndex}` }),
        core({ type: 'work-finished', durationMs: 100, outcome: 'completed', forkTurnId: null,
          btw: { conversationId: 'side', turnIndex, continuationAvailable: turnIndex < 3 } }),
      )
    }
    events.push(...works(4),
      { type: 'user-message', text: '进行中的工作', startsTurn: true },
      core({ type: 'turn-start', turnId: 'active' }),
      { type: 'user-message', inputId: 'steer', text: '增加一项核实', startsTurn: false },
      core({ type: 'tool-start', toolUseId: 'live', toolName: 'ListDir', input: { path: '.' } }),
    )
    const page = conversationHistoryWindow(createConversationState(events))
    const users = page.view.blocks.filter((block) => block.kind === 'user')
    assert.deepEqual(users.slice(0, 3).map((block) => block.text), ['侧问题 1', '侧问题 2', '侧问题 3'])
    assert.deepEqual(users.slice(-2).map((block) => block.text), ['进行中的工作', '增加一项核实'])
    assert.equal(page.view.blocks.at(-1)?.kind, 'tool')
  })

  it('短会话和空会话直接展示，没有更早页入口', () => {
    for (const count of [0, 1, 6]) {
      const state = createConversationState(works(count))
      const page = conversationHistoryWindow(state)
      assert.equal(page.before, null)
      assert.deepEqual(restoreConversationSnapshot(page.view), state)
    }
  })

  it('停止或失败后的过程在切回历史快照时继续展开', () => {
    for (const outcome of ['stopped', 'error'] as const) {
      const state = createConversationState([
        { type: 'user-message', inputId: 'current-input', text: '检查网页', startsTurn: true },
        core({ type: 'turn-start', turnId: 'current-turn' }),
        core({ type: 'text-delta', text: '正在检查' }),
        core({ type: 'work-finished', durationMs: 100, outcome, forkTurnId: 'current-turn' }),
      ])
      const restored = restoreConversationSnapshot(conversationHistoryWindow(state).view)
      const section = conversationSections(restored.blocks)[0]!
      assert.equal(restored.expanded.has(section.id), true)
      assert.deepEqual(restored, state)
    }
  })
})

describe('宿主历史投影', () => {
  it('并发读取共用增量投影，无新增事件时不重新复制历史', async () => {
    const projection = new ConversationHistoryProjection()
    const events = works(65)
    const [left, right] = await Promise.all([projection.update(events, []), projection.update(events, [])])
    assert.strictEqual(left, right)
    assert.strictEqual(await projection.update(events, []), left)
    events.push(...work(65))
    assert.deepEqual(await projection.update(events, []), createConversationState(events))
    assert.equal(projection.eventCount, events.length)
  })

  it('冷投影让出主线程，期间追加的事件不会遗漏', async () => {
    const projection = new ConversationHistoryProjection()
    const events = works(1_000)
    let pending = true
    const projecting = projection.update(events, []).then((state) => { pending = false; return state })
    await setImmediate()
    assert.equal(pending, true)
    events.push(...work(1_000))
    const state = await projecting
    assert.equal(state.blocks.filter((block) => block.kind === 'user').length, 1_001)
    assert.equal(projection.eventCount, events.length)
  })
})
