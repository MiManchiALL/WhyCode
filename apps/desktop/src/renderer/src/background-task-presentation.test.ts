import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  backgroundTaskStatusLabel,
  formatBackgroundTaskDuration,
} from './background-task-presentation.ts'

describe('后台任务展示', () => {
  it('按运行中与终态时间计算紧凑耗时', () => {
    const startedAt = '2026-08-18T00:00:00.000Z'
    assert.equal(formatBackgroundTaskDuration({ startedAt }, Date.parse(startedAt) + 9_000), '9秒')
    assert.equal(formatBackgroundTaskDuration({ startedAt }, Date.parse(startedAt) + 62_000), '1分2秒')
    assert.equal(formatBackgroundTaskDuration({
      startedAt,
      endedAt: '2026-08-18T01:05:00.000Z',
    }), '1小时5分')
  })

  it('为所有生命周期状态提供稳定文案', () => {
    assert.equal(backgroundTaskStatusLabel('running'), '运行中')
    assert.equal(backgroundTaskStatusLabel('completed'), '已完成')
    assert.equal(backgroundTaskStatusLabel('failed'), '失败')
    assert.equal(backgroundTaskStatusLabel('stopped'), '已停止')
    assert.equal(backgroundTaskStatusLabel('interrupted'), '已中断')
  })
})
