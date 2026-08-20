import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Block } from './conversation-state.ts'
import {
  centeredConversationNavigationOffset,
  conversationNavigationCapacity,
  conversationNavigationEntries,
  conversationNavigationIndexAtY,
  conversationNavigationMarkerWidth,
  reconcileConversationNavigationOffset,
  sameConversationNavigationTimeline,
  visibleConversationNavigationMarkers,
} from './conversation-navigation.ts'
import type { ConversationSection } from './conversation-sections.ts'

describe('会话定位数据投影', () => {
  it('每条用户输入只保留有界纯文本标题和对应回答摘要', () => {
    const first = user('user-1', '**检查这个项目**\n并解释实现')
    const second = user('user-2', '', { pdf: true })
    const sections: ConversationSection[] = [
      { kind: 'block', id: first.id, block: first },
      {
        kind: 'completed-work',
        id: 'work-2',
        forkTurnId: null,
        duration: {
          kind: 'work-duration',
          id: 'duration-2',
          forkTurnId: null,
          durationMs: 100,
          outcome: 'completed',
        },
        userBlocks: [second],
        activityBlocks: [],
        finalBlocks: [{
          kind: 'text',
          id: 'answer-2',
          phase: 'final',
          text: '结果见 [正式说明](https://example.com)，并且已经完成验证。',
        }],
      },
    ]

    assert.deepEqual(conversationNavigationEntries(sections), [
      { id: 'user-1', title: '检查这个项目 并解释实现', preview: null },
      {
        id: 'user-2',
        title: 'PDF 消息',
        preview: '结果见 正式说明，并且已经完成验证。',
      },
    ])
  })
})

describe('会话定位固定窗口几何', () => {
  it('无论历史多长都只投影一屏刻度，并淡化上下边缘', () => {
    const height = 720
    assert.equal(conversationNavigationCapacity(height), 40)
    const offset = centeredConversationNavigationOffset(80, 200, height)
    const markers = visibleConversationNavigationMarkers(200, height, offset)

    assert.ok(markers.length <= 42)
    assert.ok(markers[0]!.edgeOpacity < 0.5)
    assert.ok(markers.at(-1)!.edgeOpacity < 0.5)
    assert.equal(
      conversationNavigationIndexAtY(height / 2, offset, 200, height),
      80,
    )
  })

  it('只淡化仍有隐藏锚点的一侧', () => {
    const height = 720
    const firstWindow = visibleConversationNavigationMarkers(200, height, 0)
    const lastWindow = visibleConversationNavigationMarkers(200, height, 160)

    assert.equal(firstWindow[0]!.edgeOpacity, 1)
    assert.ok(firstWindow.at(-1)!.edgeOpacity < 0.5)
    assert.ok(lastWindow[0]!.edgeOpacity < 0.5)
    assert.equal(lastWindow.at(-1)!.edgeOpacity, 1)
  })

  it('波峰连续衰减，同时保留相邻基础刻度的轻微差异', () => {
    const selected = conversationNavigationMarkerWidth(10, 10)
    const neighbor = conversationNavigationMarkerWidth(11, 10)
    const farEven = conversationNavigationMarkerWidth(20, 10)
    const farOdd = conversationNavigationMarkerWidth(21, 10)

    assert.ok(selected > neighbor)
    assert.ok(neighbor > farEven)
    assert.equal(Math.abs(farEven - farOdd), 2)
  })

  it('指针离开定位轨后所有刻度恢复基础长度', () => {
    assert.equal(conversationNavigationMarkerWidth(10, null), 9)
    assert.equal(conversationNavigationMarkerWidth(11, null), 7)
  })

  it('保留手动浏览位置，离开或缩放时只裁剪越界部分', () => {
    assert.equal(
      reconcileConversationNavigationOffset(20, 99, 100, 360, true),
      20,
    )
    assert.equal(
      reconcileConversationNavigationOffset(90, 99, 100, 240, true),
      80,
    )
  })

  it('没有手动浏览时跟随正文当前项', () => {
    assert.equal(
      reconcileConversationNavigationOffset(20, 99, 100, 360, false),
      70,
    )
    assert.equal(
      reconcileConversationNavigationOffset(20, 0, 100, 360, false),
      0,
    )
  })
})

describe('会话定位流式渲染边界', () => {
  it('忽略活动回答增量，但在工作完成后刷新稳定预览', () => {
    const userBlock = user('user-1', '检查实现')
    const active = work('active-work', userBlock, {
      kind: 'text',
      id: 'answer-1',
      phase: 'pending',
      text: '正在检查',
    })
    const nextDelta = work('active-work', userBlock, {
      kind: 'text',
      id: 'answer-1',
      phase: 'pending',
      text: '正在检查更多内容',
    })
    const completed: ConversationSection[] = [{
      kind: 'completed-work',
      id: 'work-1',
      forkTurnId: null,
      duration: {
        kind: 'work-duration',
        id: 'duration-1',
        forkTurnId: null,
        durationMs: 100,
        outcome: 'completed',
      },
      userBlocks: [userBlock],
      activityBlocks: [],
      finalBlocks: [{
        kind: 'text',
        id: 'answer-1',
        phase: 'final',
        text: '检查完成',
      }],
    }]

    assert.equal(conversationNavigationEntries(active)[0]?.preview, null)
    assert.equal(sameConversationNavigationTimeline(active, nextDelta), true)
    assert.equal(sameConversationNavigationTimeline(nextDelta, completed), false)
    assert.equal(conversationNavigationEntries(completed)[0]?.preview, '检查完成')
  })
})

function user(
  id: string,
  text: string,
  options: { pdf?: boolean } = {},
): Extract<Block, { kind: 'user' }> {
  return {
    kind: 'user',
    id,
    text,
    ...(options.pdf ? {
      pdfAttachments: [{
        id: '11111111-1111-4111-8111-111111111111',
        sessionId: '22222222-2222-4222-8222-222222222222',
        name: 'paper.pdf',
        storageName: '11111111-1111-4111-8111-111111111111.pdf',
        mediaType: 'application/pdf',
        sha256: '0'.repeat(64),
        byteLength: 10,
        pageCount: 1,
      }],
    } : {}),
  }
}

function work(
  kind: 'active-work',
  userBlock: Extract<Block, { kind: 'user' }>,
  answer: Extract<Block, { kind: 'text' }>,
): Extract<ConversationSection, { kind: 'active-work' }>[] {
  return [{
    kind,
    id: 'work-1',
    startedAt: 1,
    userBlocks: [userBlock],
    activityBlocks: [],
    finalBlocks: [answer],
  }]
}
