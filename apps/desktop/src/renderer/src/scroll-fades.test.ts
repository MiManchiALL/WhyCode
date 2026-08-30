import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isNearScrollEnd, scrollAreaFades } from './scroll-fades.ts'

describe('有限滚动区边缘状态', () => {
  it('只在对应方向还有隐藏内容时显示渐隐', () => {
    assert.deepEqual(
      scrollAreaFades({ scrollTop: 0, scrollHeight: 200, clientHeight: 300 }),
      { top: false, bottom: false },
    )
    assert.deepEqual(
      scrollAreaFades({ scrollTop: 0, scrollHeight: 800, clientHeight: 300 }),
      { top: false, bottom: true },
    )
    assert.deepEqual(
      scrollAreaFades({ scrollTop: 240, scrollHeight: 800, clientHeight: 300 }),
      { top: true, bottom: true },
    )
    assert.deepEqual(
      scrollAreaFades({ scrollTop: 500, scrollHeight: 800, clientHeight: 300 }),
      { top: true, bottom: false },
    )
  })

  it('接近底部时继续跟随流式内容，主动上滚后暂停', () => {
    assert.equal(
      isNearScrollEnd({ scrollTop: 476, scrollHeight: 800, clientHeight: 300 }),
      true,
    )
    assert.equal(
      isNearScrollEnd({ scrollTop: 420, scrollHeight: 800, clientHeight: 300 }),
      false,
    )
  })
})
