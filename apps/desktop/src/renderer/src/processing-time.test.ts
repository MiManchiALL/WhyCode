import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatFinishedWorkTime, formatProcessingTime } from './processing-time.ts'

describe('工作计时显示', () => {
  it('按整分钟和秒格式化，并把负值收敛到零', () => {
    assert.equal(formatProcessingTime(-1), '已处理 0m 0s')
    assert.equal(formatProcessingTime(999), '已处理 0m 0s')
    assert.equal(formatProcessingTime(61_999), '已处理 1m 1s')
  })

  it('只有用户主动停止使用专属终态文案', () => {
    assert.equal(formatFinishedWorkTime(61_999, 'completed'), '已处理 1m 1s')
    assert.equal(formatFinishedWorkTime(61_999, 'stopped'), '你在 1m 1s 后停止了')
  })
})
