import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyCoreEvent, createConversationState } from '../../shared/conversation-state.ts'
import { conversationSections } from '../../shared/conversation-sections.ts'
import { conversationHistoryWindow } from '../../main/conversation-history.ts'
import {
  applyExpandedOverrides,
  captureScrollPosition,
  ConversationPresentationCache,
  restoredAnchorScrollTop,
  restoredScrollTop,
} from './conversation-presentation.ts'

describe('会话展示偏好', () => {
  it('重新发送后在后台完成，切回不继承旧一轮的手动展开，但保留其它轮次的选择', () => {
    let state = createConversationState()
    for (const id of ['earlier', 'old']) {
      state = applyCoreEvent(state, { type: 'user-message-accepted', inputId: id, text: '操作网页', startsTurn: true })
      state = applyCoreEvent(state, { type: 'turn-start', turnId: id })
      state = applyCoreEvent(state, { type: 'text-delta', text: '已完成' })
      state = applyCoreEvent(state, { type: 'step-committed' })
      state = applyCoreEvent(state, { type: 'work-finished', durationMs: 100, outcome: 'completed', forkTurnId: id })
    }
    const [earlier, old] = conversationSections(state.blocks)
    const cache = new ConversationPresentationCache()
    cache.setExpanded('session', earlier!.id, true)
    cache.setExpanded('session', old!.id, true)
    const userId = state.blocks.find(block => block.kind === 'user' && block.inputId === 'old')!.id
    state = applyCoreEvent(state, { type: 'user-message-edited', previousTurnId: 'old', inputId: 'retry', text: '操作网页', taskPlan: null })
    state = applyCoreEvent(state, { type: 'turn-start', turnId: 'retry' })
    state = applyCoreEvent(state, { type: 'text-delta', text: '已重新完成' })
    state = applyCoreEvent(state, { type: 'step-committed' })
    state = applyCoreEvent(state, { type: 'work-finished', durationMs: 200, outcome: 'completed', forkTurnId: 'retry' })
    const snapshot = conversationHistoryWindow(state).view
    const retry = conversationSections(snapshot.blocks).at(-1)!
    assert.equal(snapshot.blocks.find(block => block.kind === 'user' && block.inputId === 'retry')!.id, userId, '消息定位锚点仍保留')
    const restored = applyExpandedOverrides(new Set(snapshot.expanded), cache.get('session')?.expandedOverrides)
    assert.equal(restored.has(retry.id), false, '新一次执行不得继承旧过程的手动展开')
    assert.equal(restored.has(earlier!.id), true, '其它历史过程的手动选择不受影响')
    cache.setExpanded('session', retry.id, true)
    assert.equal(applyExpandedOverrides(new Set(snapshot.expanded), cache.get('session')?.expandedOverrides).has(retry.id), true)
  })

  it('只用手动覆盖修正重放默认值，并保留新内容的默认展开状态', () => {
    const expanded = applyExpandedOverrides(
      new Set(['ask-work', 'new-work']),
      new Map([
        ['ask-work', false],
        ['completed-work', true],
      ]),
    )

    assert.deepEqual([...expanded].sort(), ['completed-work', 'new-work'])
  })

  it('贴底会话按新内容高度回到底部', () => {
    const saved = captureScrollPosition({
      scrollTop: 944,
      scrollHeight: 1_000,
      clientHeight: 20,
    })

    assert.equal(saved.atBottom, true)
    assert.equal(restoredScrollTop(saved, {
      scrollTop: 0,
      scrollHeight: 2_000,
      clientHeight: 400,
    }), 1_600)
  })

  it('向上阅读时恢复原位置，并在内容缩短后安全截断', () => {
    const saved = captureScrollPosition(
      { scrollTop: 320, scrollHeight: 1_000, clientHeight: 400 },
      { sectionId: 'work-b3', offset: 120 },
    )

    assert.equal(saved.atBottom, false)
    assert.deepEqual(saved.anchor, { sectionId: 'work-b3', offset: 120 })
    assert.equal(restoredScrollTop(saved, {
      scrollTop: 0,
      scrollHeight: 1_200,
      clientHeight: 400,
    }), 320)
    assert.equal(restoredScrollTop(saved, {
      scrollTop: 0,
      scrollHeight: 500,
      clientHeight: 400,
    }), 100)
  })

  it('按稳定工作段锚点恢复，并约束在当前滚动边界内', () => {
    const metrics = { scrollTop: 0, scrollHeight: 2_000, clientHeight: 400 }
    assert.equal(restoredAnchorScrollTop(700, 120, metrics), 820)
    assert.equal(restoredAnchorScrollTop(1_550, 120, metrics), 1_600)
  })

  it('只保留最近会话和有界数量的手动开合覆盖', () => {
    const cache = new ConversationPresentationCache()
    for (let index = 0; index < 32; index++) {
      cache.saveScroll(`session-${index}`, { atBottom: true, scrollTop: 0 })
    }
    cache.get('session-0')
    cache.saveScroll('session-32', { atBottom: true, scrollTop: 0 })

    assert.equal(cache.size, 32)
    assert.equal(cache.get('session-1'), undefined)
    assert.ok(cache.get('session-0'))

    for (let index = 0; index < 257; index++) {
      cache.setExpanded('session-32', `work-${index}`, true)
    }
    const overrides = cache.get('session-32')?.expandedOverrides
    assert.equal(overrides?.size, 256)
    assert.equal(overrides?.has('work-0'), false)
    assert.equal(overrides?.has('work-256'), true)
  })

  it('文件树与对话阅读位置按会话独立保存，沿用同一淘汰和删除边界', () => {
    const cache = new ConversationPresentationCache()
    const position = {
      rootPath: '/home/Lin', scrollTop: 920,
      anchor: { path: 'fpga/notes.txt', offset: 5 }, directories: { '': 400, fpga: 200 },
    }
    cache.saveWorkspacePosition('a', position)
    cache.saveScroll('a', { atBottom: false, scrollTop: 130 })
    cache.setExpanded('a', 'work-1', true)
    assert.deepEqual(cache.get('a')?.workspacePosition, position)
    assert.equal(cache.get('a')?.scroll?.scrollTop, 130)
    assert.equal(cache.get('b'), undefined)
    cache.saveWorkspacePosition('a', undefined)
    assert.equal(cache.get('a')?.workspacePosition, undefined)
    assert.equal(cache.get('a')?.scroll?.scrollTop, 130)
    for (let index = 0; index < 32; index++) cache.saveWorkspacePosition(`session-${index}`, position)
    assert.equal(cache.size, 32)
    assert.equal(cache.get('a'), undefined)
    cache.delete('session-0')
    assert.equal(cache.get('session-0'), undefined)
  })

  it('Mermaid 查看方式按会话和图表独立保留，切回图表与删除会话移除选择', () => {
    const cache = new ConversationPresentationCache()
    cache.setMermaidSource('a', 'message:10', true)
    cache.setMermaidSource('a', 'message:80', true)
    cache.saveScroll('a', { atBottom: false, scrollTop: 120 })
    cache.setExpanded('a', 'work-1', true)
    cache.saveWorkspacePosition('a', undefined)
    cache.setMermaidSource('b', 'message:10', false)
    assert.equal(cache.get('b'), undefined)
    assert.deepEqual([...cache.get('a')!.mermaidSources!], ['message:10', 'message:80'])
    assert.deepEqual([...cache.get('a')!.expandedOverrides], [['work-1', true]])
    cache.setMermaidSource('a', 'message:10', false)
    assert.deepEqual([...cache.get('a')!.mermaidSources!], ['message:80'])
    assert.equal(cache.get('a')?.scroll?.scrollTop, 120)
    cache.delete('a')
    assert.equal(cache.get('a'), undefined)
  })

  it('Mermaid 选择不保留无界图表或已淘汰会话', () => {
    const cache = new ConversationPresentationCache()
    for (let index = 0; index < 256; index++) cache.setMermaidSource('a', `message:${index}`, true)
    cache.setMermaidSource('a', 'message:0', true)
    cache.setMermaidSource('a', 'message:256', true)
    assert.equal(cache.get('a')?.mermaidSources?.size, 256)
    assert.equal(cache.get('a')?.mermaidSources?.has('message:0'), true)
    assert.equal(cache.get('a')?.mermaidSources?.has('message:1'), false)
    for (let index = 0; index < 32; index++) cache.setMermaidSource(`session-${index}`, 'message:0', true)
    assert.equal(cache.size, 32)
    assert.equal(cache.get('a'), undefined)
  })
})
