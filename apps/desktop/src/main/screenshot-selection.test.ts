import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  fitImageSize,
  findWindowSource,
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

  it('只按完整标题匹配，聊天标题提及目标应用时不得自动截图', () => {
    const sources = [
      source('window:1', 'WhyCode — Project A'),
      source('window:2', 'WhyCode — Project B'),
      source('window:3', 'Browser'),
    ]
    assert.equal(selectWindowSource(sources, 'browser').id, 'window:3')
    assert.equal(selectWindowSource(sources, 'WhyCode — Project A').id, 'window:1')
    assert.throws(() => selectWindowSource(sources, 'WhyCode'), /找不到窗口/)
    assert.throws(() => selectWindowSource(sources, '   '), /标题不能为空/)
    assert.equal(findWindowSource(sources, 'Missing application'), undefined)
    assert.equal(findWindowSource([source('window:4', '查看飞书 - DeepSeek Harness')], '飞书'), undefined)
    assert.throws(() => selectWindowSource(sources, 'Missing application'), /找不到窗口/)
  })

  it('重名窗口保留不同身份，候选 ID 可精确选择，失效 ID 不退回标题猜选', () => {
    const windows = [source('101:7', 'ToDesk'), source('102:7', 'ToDesk')]
    assert.throws(() => selectWindowSource(windows, 'ToDesk'), error => {
      assert.match(String(error), /window_id="101:7"/)
      assert.match(String(error), /window_id="102:7"/)
      return true
    })
    assert.equal(selectWindowSource(windows, undefined, '102:7'), windows[1])
    assert.throws(() => selectWindowSource(windows, 'ToDesk', '102:8'), /已失效/)
  })
})

describe('区域截图坐标换算', () => {
  it('把 0～1000 标准化区域映射到真实截图像素', () => {
    assert.deepEqual(
      regionCrop(
        { x: 250, y: 250, width: 500, height: 500 },
        { width: 3_840, height: 2_160 },
        1_000,
      ),
      { x: 960, y: 540, width: 1_920, height: 1_080 },
    )
  })

  it('使用向外取整覆盖非整数像素并把末端约束在截图边界内', () => {
    assert.deepEqual(
      regionCrop(
        { x: 999, y: 999, width: 1, height: 1 },
        { width: 1_920, height: 1_080 },
        1_000,
      ),
      { x: 1_918, y: 1_078, width: 2, height: 2 },
    )
  })

  it('拒绝越界、负坐标和无效尺寸', () => {
    const image = { width: 1_920, height: 1_080 }
    assert.throws(
      () => regionCrop({ x: 900, y: 0, width: 200, height: 10 }, image, 1_000),
      /标准化边界/,
    )
    assert.throws(
      () => regionCrop({ x: -1, y: 0, width: 10, height: 10 }, image, 1_000),
      /非负标准化坐标/,
    )
    assert.throws(
      () => regionCrop({ x: 0, y: 0, width: 0, height: 10 }, image, 1_000),
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
