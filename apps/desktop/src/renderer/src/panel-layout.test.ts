import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  loadPanelWidth,
  panelWidthBounds,
  panelWidthFromPixels,
  parsePanelWidth,
  persistPanelWidth,
  projectPanelResize,
  PANEL_CLOSE_OVERSHOOT,
  minimumConversationWidth,
  type PanelGeometry,
  type PanelSide,
} from './panel-layout.ts'

describe('两侧栏宽度', () => {
  it('缺省和损坏偏好使用默认宽度，超出范围的值服从当前上限', () => {
    for (const value of [null, '', ' ', 'invalid', 'Infinity']) {
      assert.equal(parsePanelWidth('left', value), 260)
      assert.equal(parsePanelWidth('right', value), 0.36)
    }
    assert.equal(parsePanelWidth('left', '280'), 280)
    assert.equal(parsePanelWidth('left', '100'), 240)
    assert.equal(parsePanelWidth('left', '600'), 360)
    assert.equal(parsePanelWidth('right', '0.28'), 0.28)
    assert.equal(parsePanelWidth('right', '0.12'), 0.2)
    assert.equal(parsePanelWidth('right', '0.9'), 0.5)
  })

  it('分别保存全局宽度；缩窄窗口不会改写用户偏好', (context) => {
    const values = new Map<string, string>()
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    context.after(() => {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    })
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value) },
      },
    })
    persistPanelWidth('left', 340)
    persistPanelWidth('right', 0.28)
    assert.deepEqual(panelWidthBounds({ ...geometry(800, 240, 126), side: 'left' }), {
      minWidth: 240, maxWidth: 240,
    })
    assert.equal(loadPanelWidth('left'), 340)
    assert.equal(loadPanelWidth('right'), 0.28)
  })

  it('扩大右侧上限时由左侧让出空间，反向扩展左侧也保持原对话宽度', () => {
    const original = geometry(1_920, 360, 864)
    assert.equal(minimumConversationWidth(original), 682)
    assert.deepEqual(panelWidthBounds({ ...original, side: 'left' }), {
      minWidth: 240, maxWidth: 360,
    })
    const right = panelWidthBounds({ ...original, side: 'right' })
    assert.equal(right.minWidth, 384)
    assert.equal(right.maxWidth, 960)
    assert.deepEqual(resize(original, 'right', 960).widths, { left: 264, right: 960 })
    assert.deepEqual(resize(geometry(1_920, 264, 960), 'left', 360).widths, { left: 360, right: 864 })
    assert.deepEqual(resize(original, 'right', 900).widths, { left: 324, right: 900 })
    assert.deepEqual(resize(original, 'right', 850).widths, { left: 360, right: 850 })
  })

  it('另一侧到达最小宽度后仍保留收起缓冲，原本收起的侧栏不被拖拽重新展开', () => {
    assert.deepEqual(resize(geometry(2_560, 360, 1_152), 'right', 1_280).widths, { left: 240, right: 1_272 })
    const leftClosed = { ...geometry(1_920, 62, 864), open: { left: false, right: true } }
    assert.deepEqual(resize(leftClosed, 'right', 960), { widths: { left: 62, right: 960 }, open: leftClosed.open })
    const rightClosed = { ...geometry(1_920, 260, 360), open: { left: true, right: false } }
    assert.deepEqual(resize(rightClosed, 'left', 360), { widths: { left: 360, right: 360 }, open: rightClosed.open })
  })

  it('窄窗口继续调宽右侧时可收起左侧，同一手势反向越过边界后恢复', () => {
    const start = geometry(1_000, 300, 266)
    assert.deepEqual(resize(start, 'right', 397), { widths: { left: 240, right: 326 }, open: start.open })
    const closed = resize(start, 'right', 398)
    assert.deepEqual(closed, { widths: { left: 62, right: 398 }, open: { left: false, right: true } })
    assert.deepEqual(resize(start, 'right', 600, closed.open).widths, { left: 62, right: 500 })
    assert.equal(resize(start, 'right', 327, closed.open).open.left, false)
    const reopened = resize(start, 'right', 326, closed.open)
    assert.deepEqual(reopened, { widths: { left: 240, right: 326 }, open: start.open })
    assert.equal(resize(start, 'right', 397, reopened.open).open.left, true)
    assert.deepEqual(resize(start, 'right', 266, reopened.open).widths, start.widths)
  })

  it('调宽左侧也可以收起右侧，反向拖回恢复原来分配且不压缩对话区', () => {
    const start = geometry(860, 240, 186)
    assert.deepEqual(resize(start, 'left', 325).widths, { left: 254, right: 172 })
    const closed = resize(start, 'left', 326)
    assert.deepEqual(closed, { widths: { left: 258, right: 0 }, open: { left: true, right: false } })
    assert.equal(resize(start, 'left', 255, closed.open).open.right, false)
    const reopened = resize(start, 'left', 254, closed.open)
    assert.deepEqual(reopened, { widths: { left: 254, right: 172 }, open: start.open })
    assert.deepEqual(resize(start, 'left', 240, reopened.open).widths, start.widths)
  })

  it('自身已达上限或收起不能释放空间时，不收起另一侧', () => {
    const wide = geometry(1_920, 264, 960)
    assert.deepEqual(resize(wide, 'right', 1_200), { widths: wide.widths, open: wide.open })
    const noSpace = { ...geometry(1_000, 300, 266), collapsedWidths: { left: 240, right: 0 } }
    assert.equal(resize(noSpace, 'right', 500).open.left, true)
  })

  it('键盘调宽在超过展开上限时收起对侧，停在边界上不会收起', () => {
    const start = geometry(1_000, 240, 326)
    assert.equal(resize(start, 'right', 326, start.open, 0).open.left, true)
    assert.deepEqual(resize(start, 'right', 346, start.open, 0), {
      widths: { left: 62, right: 346 }, open: { left: false, right: true },
    })
  })

  it('窄窗口维持阅读下限，整体空间不足时不溢出', () => {
    assert.deepEqual(panelWidthBounds({ ...geometry(800, 240, 126), side: 'right' }), {
      minWidth: 126, maxWidth: 126,
    })
    assert.deepEqual(panelWidthBounds({ ...geometry(500, 150, 0), side: 'right' }), {
      minWidth: 0, maxWidth: 0,
    })
    assert.equal(minimumConversationWidth(geometry(500, 150, 0)), 336)
    for (const viewport of [800, 1_024, 1_200, 1_440, 1_920, 2_560]) {
      const input = geometry(viewport, Math.min(360, viewport * 0.3), 0)
      const initialRight = Math.min(viewport * 0.45, input.layoutWidth - input.widths.left - minimumConversationWidth(input))
      input.widths.right = initialRight
      for (const side of ['left', 'right'] as const) {
        const result = resize(input, side, viewport).widths
        assert.ok(input.layoutWidth - result.left - result.right >= minimumConversationWidth(input) - 0.01)
        assert.ok(result.left >= 0 && result.right >= 0)
      }
    }
  })

  for (const side of ['left', 'right'] as const) {
    it(`${side}：最小宽度之后继续向外拖才收起，按住反向拖回最小宽度恢复`, () => {
      const start = geometry(side === 'left' ? 1_200 : 800, 240, 300)
      start.open[side === 'left' ? 'right' : 'left'] = false
      start.widths[side === 'left' ? 'right' : 'left'] = 0
      const bounds = panelWidthBounds({ ...start, side })
      const drag = (delta: number, collapsed = false) => {
        const result = resize(start, side, bounds.minWidth + delta, { ...start.open, [side]: !collapsed })
        return { width: result.widths[side], shouldCollapse: !result.open[side] }
      }
      assert.deepEqual(drag(500), { width: bounds.maxWidth, shouldCollapse: false })
      assert.deepEqual(drag(0), { width: bounds.minWidth, shouldCollapse: false })
      assert.deepEqual(drag(-71), { width: bounds.minWidth, shouldCollapse: false })
      assert.deepEqual(drag(-72), { width: start.collapsedWidths[side], shouldCollapse: true })
      assert.deepEqual(drag(-1, true), { width: start.collapsedWidths[side], shouldCollapse: true })
      assert.deepEqual(drag(0, true), { width: bounds.minWidth, shouldCollapse: false })
      assert.deepEqual(drag(20, true), { width: bounds.minWidth + 20, shouldCollapse: false })
    })
  }

  it('指针宽度使用各自的持久单位，零尺寸面板不会触发误收起', () => {
    assert.equal(panelWidthFromPixels('left', 312, 1_920), 312)
    assert.equal(panelWidthFromPixels('right', 576, 1_920), 0.3)
    for (const side of ['left', 'right'] as PanelSide[]) {
      const empty = geometry(0, 0, 0)
      assert.deepEqual(resize(empty, side, 300), { widths: empty.widths, open: empty.open })
    }
  })
})

function geometry(viewportWidth: number, left: number, right: number): PanelGeometry {
  return {
    viewportWidth, layoutWidth: Math.max(0, viewportWidth - 14), widths: { left, right },
    collapsedWidths: { left: 62, right: viewportWidth > 1_440 ? 360 : 0 }, open: { left: true, right: true },
  }
}

function resize(input: PanelGeometry, side: PanelSide, requestedWidth: number, previousOpen = input.open, closeOvershoot = PANEL_CLOSE_OVERSHOOT) {
  return projectPanelResize({ geometry: input, side, requestedWidth, previousOpen, closeOvershoot })
}
