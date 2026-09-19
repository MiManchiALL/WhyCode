import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  loadPanelWidth,
  panelWidthBounds,
  panelWidthFromPixels,
  parsePanelWidth,
  persistPanelWidth,
  projectPanelDrag,
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
    assert.equal(parsePanelWidth('right', '0.9'), 0.45)
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
    assert.deepEqual(panelWidthBounds({ side: 'left', viewportWidth: 800, containerWidth: 800 }), {
      minWidth: 240, maxWidth: 240,
    })
    assert.equal(loadPanelWidth('left'), 340)
    assert.equal(loadPanelWidth('right'), 0.28)
  })

  it('两侧最宽仍保留对话空间', () => {
    assert.deepEqual(panelWidthBounds({ side: 'left', viewportWidth: 1_920, containerWidth: 1_920 }), {
      minWidth: 240, maxWidth: 360,
    })
    const right = panelWidthBounds({ side: 'right', viewportWidth: 1_920, containerWidth: 1_546 })
    assert.equal(right.minWidth, 384)
    assert.equal(right.maxWidth, 864)
    assert.equal(1_546 - right.maxWidth, 682)
    assert.deepEqual(panelWidthBounds({ side: 'right', viewportWidth: 800, containerWidth: 546 }), {
      minWidth: 126, maxWidth: 126,
    })
    assert.deepEqual(panelWidthBounds({ side: 'right', viewportWidth: 500, containerWidth: 200 }), {
      minWidth: 0, maxWidth: 0,
    })
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
      const bounds = panelWidthBounds({ side, viewportWidth: 0, containerWidth: 0 })
      assert.deepEqual(projectPanelDrag({ side, bounds, startX: 0, pointerX: 300, startWidth: 0, collapsed: false }), {
        width: 0, shouldCollapse: false,
      })
    }
  })
})
