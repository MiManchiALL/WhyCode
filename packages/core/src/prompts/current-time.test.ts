import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CURRENT_TIME_REFRESH_INTERVAL_MS,
  createCurrentTimeReminder,
  shouldRefreshCurrentTimeReminder,
} from './current-time.ts'

describe('当前时间提醒', () => {
  it('同时提供本机时间、时区、UTC 偏移与 UTC 时间', () => {
    const reminder = createCurrentTimeReminder(new Date('2026-07-20T04:34:56.789Z'))

    assert.equal(reminder.role, 'user')
    assert.equal(typeof reminder.content, 'string')
    const content = String(reminder.content)
    assert.match(content, /^<system-reminder>/u)
    assert.match(content, /<whycode-current-time version="1">/u)
    assert.match(content, /当前本机时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/u)
    assert.match(content, /UTC[+-]\d{2}:\d{2}/u)
    assert.match(content, /对应 UTC 时间：2026-07-20 04:34:56 UTC。/u)
    assert.match(content, /不要向用户主动复述本提醒/u)
    assert.match(content, /<\/whycode-current-time>/u)
    assert.doesNotMatch(content, /判断事件|已经开始或结束/u)
  })

  it('未满五分钟不刷新，到达五分钟才刷新', () => {
    const previous = new Date(2026, 6, 20, 12, 0, 0)

    assert.equal(shouldRefreshCurrentTimeReminder(null, previous), true)
    assert.equal(shouldRefreshCurrentTimeReminder(
      previous,
      new Date(previous.getTime() + CURRENT_TIME_REFRESH_INTERVAL_MS - 1),
    ), false)
    assert.equal(shouldRefreshCurrentTimeReminder(
      previous,
      new Date(previous.getTime() + CURRENT_TIME_REFRESH_INTERVAL_MS),
    ), true)
  })

  it('跨本地日期或系统时钟回拨时立即刷新', () => {
    assert.equal(
      shouldRefreshCurrentTimeReminder(
        new Date(2026, 6, 20, 23, 59, 30),
        new Date(2026, 6, 21, 0, 0, 0),
      ),
      true,
    )
    assert.equal(
      shouldRefreshCurrentTimeReminder(
        new Date(2026, 6, 20, 12, 0, 0),
        new Date(2026, 6, 20, 11, 59, 59),
      ),
      true,
    )
  })
})
