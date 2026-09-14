import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { describe, it } from 'node:test'
import type { CoreEvent, ViewEvent } from '@whycode/core'
import { ConversationHistoryProjection, conversationHistoryWindow } from './conversation-history.ts'
import { applyCoreEvent, applyViewEvent, createConversationState } from '../shared/conversation-state.ts'
import { prependConversationHistory, restoreConversationSnapshot } from '../shared/conversation-history.ts'
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
  it('首批只发最近 20 个完整工作，逐页补载与完整投影一致', () => {
    const full = createConversationState(works(65))
    let page = conversationHistoryWindow(full)
    let view = restoreConversationSnapshot(structuredClone(page.view))
    assert.equal(view.blocks.filter((block) => block.kind === 'user').length, 20)
    assert.equal(page.earlierEntries.length, 45)
    assert.deepEqual([
      ...page.earlierEntries,
      ...conversationNavigationEntries(conversationSections(view.blocks)),
    ], conversationNavigationEntries(conversationSections(full.blocks)))
    while (page.before !== null) {
      page = conversationHistoryWindow(full, { before: page.before })
      view = prependConversationHistory(view, page.view)
    }
    assert.deepEqual(view, full)
    assert.equal(new Set(view.blocks.map((block) => block.id)).size, full.blocks.length)
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
    events.push(...works(18),
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

  it('跨页定位分批读取，恢复阅读窗口覆盖原来的第一块', () => {
    const full = createConversationState(works(250))
    const tail = conversationHistoryWindow(full)
    const target = full.blocks[40]!.id
    const first = conversationHistoryWindow(full, { before: tail.before!, targetId: target })
    assert.equal(first.view.blocks.filter((block) => block.kind === 'user').length, 100)
    const second = conversationHistoryWindow(full, { before: first.before!, targetId: target })
    const third = conversationHistoryWindow(full, { before: second.before!, targetId: target })
    assert.equal(third.view.blocks[0]!.id, target)
    const restored = conversationHistoryWindow(full, { from: second.view.blocks[0]!.id })
    assert.deepEqual(restored.view.blocks, full.blocks.slice(second.before!))
  })

  it('补载保留实时尾部和待提交步骤，丢弃步骤不丢失新加载的历史', () => {
    const full = createConversationState(works(45))
    const tail = conversationHistoryWindow(full)
    let view = restoreConversationSnapshot(tail.view)
    view = applyCoreEvent(view, { type: 'user-message-accepted', inputId: 'new', text: '继续', startsTurn: true })
    view = applyCoreEvent(view, { type: 'turn-start', turnId: 'new-turn' })
    const stableNextId = view.nextId
    view = applyCoreEvent(view, { type: 'text-delta', text: '尚未提交' })
    const older = conversationHistoryWindow(full, { before: tail.before! })
    view = prependConversationHistory(view, older.view)
    assert.equal(view.nextId, stableNextId + 1)
    view = applyCoreEvent(view, { type: 'step-discarded' })
    assert.equal(view.nextId, stableNextId)
    const last = view.blocks.at(-1)
    assert.equal(last?.kind === 'user' && last.text, '继续')
    assert.equal(view.blocks.length, older.view.blocks.length + tail.view.blocks.length + 1)
    assert.equal(view.turnStartBlocks.get('new-turn'), view.blocks.length - 1)
  })

  it('全局控制状态和已失效的检查点不受历史页边界影响', () => {
    const events = works(2)
    events.splice(4, 0, core({ type: 'checkpoint-created', toolUseId: 'tool-0', hash: 'hash', coverage: 'complete' }))
    events.push(...works(30), core({ type: 'checkpoint-restored', turnId: 'turn-0',
      toolUseId: 'tool-0', scope: 'files', ok: true }))
    const full = createConversationState(events)
    const page = conversationHistoryWindow(full)
    assert.equal(page.view.fileRollbackBoundaryTurnId, 'turn-0')
    const older = conversationHistoryWindow(full, { before: page.before! })
    const restoredTool = older.view.blocks.find((block) => block.kind === 'tool' && block.call.id === 'tool-0')
    assert.equal(restoredTool?.kind === 'tool' && restoredTool.call.hasCheckpoint, false)
  })

  it('回滚删除首个可见工作后仍可读取其前缀，不重新插入被删除的工作', () => {
    let full = createConversationState(works(45))
    const tail = conversationHistoryWindow(full)
    const rollback: CoreEvent = {
      type: 'checkpoint-restored', toolUseId: 'tool-25', turnId: 'turn-25', scope: 'files-and-chat', ok: true,
    }
    let view = applyCoreEvent(restoreConversationSnapshot(tail.view), rollback)
    full = applyViewEvent(full, core(rollback))
    assert.equal(view.blocks.length, 0)
    const older = conversationHistoryWindow(full, { before: tail.before! })
    view = prependConversationHistory(view, older.view)
    assert.equal(view.blocks.filter((block) => block.kind === 'user').length, 20)
    assert.equal(view.blocks.some((block) => block.kind === 'user' && block.turnId === 'turn-25'), false)
  })

  it('短会话和空会话直接展示，没有更早页入口', () => {
    for (const count of [0, 1, 20]) {
      const state = createConversationState(works(count))
      const page = conversationHistoryWindow(state)
      assert.equal(page.before, null)
      assert.deepEqual(restoreConversationSnapshot(page.view), state)
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
