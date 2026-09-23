import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  loadPanelWidth,
  panelWidthBounds,
  panelWidthFromPixels,
  parsePanelWidth,
  persistPanelWidth,
  projectPanelDrag,
  projectPanelWidths,
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
    assert.deepEqual(projectPanelWidths(original, 'right', 960), { left: 264, right: 960 })
    assert.deepEqual(projectPanelWidths(geometry(1_920, 264, 960), 'left', 360), { left: 360, right: 864 })
    assert.deepEqual(projectPanelWidths(original, 'right', 900), { left: 324, right: 900 })
    assert.deepEqual(projectPanelWidths(original, 'right', 850), { left: 360, right: 850 })
  })

  it('另一侧到达最小宽度后停止让位，收起的侧栏保持原状态和宽度', () => {
    assert.deepEqual(projectPanelWidths(geometry(2_560, 360, 1_152), 'right', 1_280), { left: 240, right: 1_272 })
    const leftClosed = { ...geometry(1_920, 62, 864), open: { left: false, right: true } }
    assert.deepEqual(projectPanelWidths(leftClosed, 'right', 960), { left: 62, right: 960 })
    const rightClosed = { ...geometry(1_920, 260, 348), open: { left: true, right: false } }
    assert.deepEqual(projectPanelWidths(rightClosed, 'left', 360), { left: 360, right: 348 })
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
        const result = projectPanelWidths(input, side, viewport)
        assert.ok(input.layoutWidth - result.left - result.right >= minimumConversationWidth(input) - 0.01)
        assert.ok(result.left >= 0 && result.right >= 0)
      }
    }
  })

  for (const side of ['left', 'right'] as const) {
    it(`${side}：最小宽度之后继续向外拖才收起，按住反向拖回最小宽度恢复`, () => {
      const drag = (pointerX: number, collapsed = false) => projectPanelDrag({
        side, startX: 500, pointerX: 500 + pointerX * (side === 'left' ? 1 : -1),
        startWidth: 300, bounds: { minWidth: 240, maxWidth: 360 }, collapsed,
      })
      assert.deepEqual(drag(100), { width: 360, shouldCollapse: false })
      assert.deepEqual(drag(-60), { width: 240, shouldCollapse: false })
      assert.deepEqual(drag(-131), { width: 240, shouldCollapse: false })
      assert.deepEqual(drag(-132), { width: 240, shouldCollapse: true })
      assert.deepEqual(drag(-61, true), { width: 240, shouldCollapse: true })
      assert.deepEqual(drag(-60, true), { width: 240, shouldCollapse: false })
      assert.deepEqual(drag(20, true), { width: 320, shouldCollapse: false })
    })
  }

  it('指针宽度使用各自的持久单位，零尺寸面板不会触发误收起', () => {
    assert.equal(panelWidthFromPixels('left', 312, 1_920), 312)
    assert.equal(panelWidthFromPixels('right', 576, 1_920), 0.3)
    for (const side of ['left', 'right'] as PanelSide[]) {
      const bounds = panelWidthBounds({ ...geometry(0, 0, 0), side })
      assert.deepEqual(projectPanelDrag({ side, bounds, startX: 0, pointerX: 300, startWidth: 0, collapsed: false }), {
        width: 0, shouldCollapse: false,
      })
    }
  })
})

function geometry(viewportWidth: number, left: number, right: number): PanelGeometry {
  return { viewportWidth, layoutWidth: Math.max(0, viewportWidth - 14), widths: { left, right }, open: { left: true, right: true } }
}
