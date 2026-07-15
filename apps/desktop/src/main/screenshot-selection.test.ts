import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  fitImageSize,
  regionCrop,
  selectDisplaySource,
  selectWindowSource,
  type ScreenshotSourceLike,
} from './screenshot-selection.ts'

function source(
  id: string,
  name: string,
  displayId = '',
): ScreenshotSourceLike {
  return { id, name, display_id: displayId }
}

describe('桌面截图源选择', () => {
  it('按 display_id 精确选择屏幕源，并只在单屏时兼容空 display_id', () => {
    const sources = [source('screen:1', 'A', '1'), source('screen:2', 'B', '2')]
    assert.equal(selectDisplaySource(sources, '2').id, 'screen:2')
    assert.equal(selectDisplaySource([source('screen:linux', 'Screen')], '17').id, 'screen:linux')
    assert.throws(() => selectDisplaySource(sources, '3'), /没有显示器 3/)
  })

  it('默认只选当前 WhyCode 窗口，不会猜测其它窗口', () => {
    const sources = [source('window:whycode', 'WhyCode'), source('window:editor', 'Editor')]
    assert.equal(selectWindowSource(sources, undefined, 'window:whycode').id, 'window:whycode')
    assert.throws(() => selectWindowSource(sources, undefined, 'window:gone'), /找不到当前 WhyCode/)
  })

  it('窗口标题优先精确匹配，唯一子串可用，歧义时明确失败', () => {
    const sources = [
      source('window:1', 'WhyCode — Project A'),
      source('window:2', 'WhyCode — Project B'),
      source('window:3', 'Browser'),
    ]
    assert.equal(selectWindowSource(sources, 'browser').id, 'window:3')
    assert.equal(selectWindowSource(sources, 'Project A').id, 'window:1')
    assert.throws(() => selectWindowSource(sources, 'WhyCode'), /标题不唯一/)
    assert.throws(() => selectWindowSource(sources, '   '), /标题不能为空/)
  })
})

describe('区域截图坐标换算', () => {
  it('把相对显示器的 DIP 区域映射到真实截图像素', () => {
    assert.deepEqual(
      regionCrop(
        { x: 100, y: 50, width: 300, height: 200 },
        { width: 1_920, height: 1_080 },
        { width: 3_840, height: 2_160 },
      ),
      { x: 200, y: 100, width: 600, height: 400 },
    )
  })

  it('处理非整数缩放并把末端裁剪约束在截图边界内', () => {
    assert.deepEqual(
      regionCrop(
        { x: 1_279, y: 719, width: 1, height: 1 },
        { width: 1_280, height: 720 },
        { width: 1_920, height: 1_080 },
      ),
      { x: 1_919, y: 1_079, width: 1, height: 1 },
    )
  })

  it('拒绝越界、负坐标和无效尺寸', () => {
    const display = { width: 1_920, height: 1_080 }
    const image = { width: 1_920, height: 1_080 }
    assert.throws(
      () => regionCrop({ x: 1_900, y: 0, width: 100, height: 10 }, display, image),
      /超出显示器/,
    )
    assert.throws(
      () => regionCrop({ x: -1, y: 0, width: 10, height: 10 }, display, image),
      /非负坐标/,
    )
    assert.throws(
      () => regionCrop({ x: 0, y: 0, width: 0, height: 10 }, display, image),
      /正尺寸/,
    )
  })
})

describe('截图解码边界', () => {
  it('保留安全尺寸，并等比缩小超大屏幕到尺寸和总像素上限内', () => {
    assert.deepEqual(fitImageSize({ width: 1_920, height: 1_080 }, 7_680, 20_000_000), {
      width: 1_920,
      height: 1_080,
    })
    const bounded = fitImageSize({ width: 7_680, height: 4_320 }, 7_680, 20_000_000)
    assert.ok(bounded.width <= 7_680)
    assert.ok(bounded.height <= 7_680)
    assert.ok(bounded.width * bounded.height <= 20_000_000)
    assert.ok(Math.abs(bounded.width / bounded.height - 16 / 9) < 0.001)
  })

  it('拒绝无效的截图尺寸', () => {
    assert.throws(() => fitImageSize({ width: 0, height: 10 }, 100, 1_000), /边界无效/)
  })
})
