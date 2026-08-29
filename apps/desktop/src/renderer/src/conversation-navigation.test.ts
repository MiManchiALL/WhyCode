import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Block } from './conversation-state.ts'
import {
  centeredConversationNavigationOffset,
  conversationNavigationCapacity,
  conversationNavigationEntries,
  conversationNavigationEntryY,
  conversationNavigationIndexAtY,
  conversationNavigationMarkerWidth,
  conversationNavigationWheelEnabled,
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
      { id: 'user-1', title: '检查这个项目 并解释实现', preview: null, isBtw: false },
      {
        id: 'user-2',
        title: 'PDF 消息',
        preview: '结果见 正式说明，并且已经完成验证。',
        isBtw: false,
      },
    ])
  })

  it('为 BTW 与 BBTW 锚点保留临时对话外观语义', () => {
    const btw = user('btw-1', '临时问题')
    btw.btw = { conversationId: 'conversation-1', turnIndex: 1, mode: 'btw' }
    const bbtw = user('btw-2', '继续追问')
    bbtw.btw = { conversationId: 'conversation-1', turnIndex: 2, mode: 'bbtw' }

    assert.deepEqual(
      conversationNavigationEntries([
        { kind: 'block', id: btw.id, block: btw },
        { kind: 'block', id: bbtw.id, block: bbtw },
      ]).map((entry) => entry.isBtw),
      [true, true],
    )
    assert.equal(
      sameConversationNavigationTimeline(
        [{ kind: 'block', id: btw.id, block: user(btw.id, btw.text) }],
        [{ kind: 'block', id: btw.id, block: btw }],
      ),
      false,
    )
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

  it('只有纵向落在锚点范围内时才命中，单个锚点不会占满整条轨道', () => {
    assert.equal(conversationNavigationIndexAtY(360, 0, 1, 720), 0)
    assert.equal(conversationNavigationIndexAtY(350, 0, 1, 720), null)
    assert.equal(conversationNavigationIndexAtY(540, 0, 1, 720), null)
  })

  it('轨道留白中的未渲染锚点不响应悬浮', () => {
    const height = 720
    const offset = 80
    const entryCount = 200
    const markers = visibleConversationNavigationMarkers(entryCount, height, offset)
    const first = markers[0]!
    const last = markers.at(-1)!
    const hiddenBeforeY = conversationNavigationEntryY(
      first.entryIndex - 1,
      entryCount,
      height,
      offset,
    )
    const hiddenAfterY = conversationNavigationEntryY(
      last.entryIndex + 1,
      entryCount,
      height,
      offset,
    )

    assert.ok(hiddenBeforeY > 0 && hiddenAfterY < height)
    assert.equal(conversationNavigationIndexAtY(first.y, offset, entryCount, height), first.entryIndex)
    assert.equal(conversationNavigationIndexAtY(last.y, offset, entryCount, height), last.entryIndex)
    assert.equal(conversationNavigationIndexAtY(hiddenBeforeY, offset, entryCount, height), null)
    assert.equal(conversationNavigationIndexAtY(hiddenAfterY, offset, entryCount, height), null)
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

  it('只有指针命中轨道锚点时才接管可滚动的定位窗口', () => {
    assert.equal(conversationNavigationWheelEnabled(true, 120, 100, 360), true)
    assert.equal(conversationNavigationWheelEnabled(false, 120, 100, 360), false)
    assert.equal(conversationNavigationWheelEnabled(true, null, 100, 360), false)
    assert.equal(conversationNavigationWheelEnabled(true, 120, 10, 360), false)
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
