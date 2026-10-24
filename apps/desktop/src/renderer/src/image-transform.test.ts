import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { constrainImage, FIT_IMAGE, imageWheelDelta, zoomImage } from './image-transform.ts'

const bounds = { width: 800, height: 600, imageWidth: 800, imageHeight: 600 }
describe('图片缩放和平移', () => {
  it('放大和缩小都保持光标下的像素不动，往返不漂移', () => {
    const point = { x: 120, y: -80 }
    const original = { scale: 2, x: -60, y: 30 }
    const next = zoomImage(original, 3, point, bounds)
    assert.equal((point.x - original.x) / original.scale, (point.x - next.x) / next.scale)
    assert.equal((point.y - original.y) / original.scale, (point.y - next.y) / next.scale)
    assert.deepEqual(zoomImage(next, 2, point, bounds), original)
  })
  it('图片始终留在画布内，较短的轴居中，缩回适应窗口重置位移', () => {
    assert.deepEqual(constrainImage({ scale: 2, x: 900, y: -800 }, bounds), { scale: 2, x: 400, y: -300 })
    assert.deepEqual(constrainImage({ scale: 2, x: 900, y: -800 }, { ...bounds, imageHeight: 200 }), { scale: 2, x: 400, y: 0 })
    assert.deepEqual(zoomImage({ scale: 2, x: 400, y: -300 }, 0.1, { x: 120, y: 80 }, bounds), FIT_IMAGE)
    assert.equal(zoomImage(FIT_IMAGE, 100, { x: 0, y: 0 }, bounds).scale, 16)
  })
  it('窗口变大时收回越界位置；滚轮的像素、行、页模式统一并限制突跳', () => {
    assert.deepEqual(constrainImage({ scale: 2, x: 400, y: -300 }, { ...bounds, width: 1200, height: 1000 }), { scale: 2, x: 200, y: -100 })
    assert.equal(imageWheelDelta(-2, 1, 600), -32)
    assert.equal(imageWheelDelta(-32, 0, 600), -32)
    assert.equal(imageWheelDelta(1, 2, 600), 160)
    assert.equal(imageWheelDelta(-800, 0, 600), -160)
  })
})
