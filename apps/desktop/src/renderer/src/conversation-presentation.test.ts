import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyExpandedOverrides,
  captureScrollPosition,
  ConversationPresentationCache,
  restoredAnchorScrollTop,
  restoredScrollTop,
} from './conversation-presentation.ts'

describe('会话展示偏好', () => {
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
})
