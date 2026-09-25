import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import { currentDateReminder } from './current-date.ts'

describe('当前日期提醒', () => {
  const morning = new Date(2026, 8, 25, 0, 30)

  it('无提醒时提供本地日期与时区，不携带时分秒或重复 UTC 时间', () => {
    const reminder = currentDateReminder([], morning)
    assert.ok(reminder)
    assert.equal(reminder.role, 'user')
    const content = String(reminder.content)
    assert.ok(content.includes(`当前日期：2026-09-25（${Intl.DateTimeFormat().resolvedOptions().timeZone}）。`))
    assert.match(content, /不是新的用户要求；不要向用户主动复述/u)
    assert.doesNotMatch(content, /\d{2}:\d{2}|对应 UTC 时间/u)
  })

  it('同日经过数小时或时钟回拨都复用当前提醒', () => {
    const reminder = currentDateReminder([], morning)!
    assert.equal(currentDateReminder([reminder], new Date(2026, 8, 25, 23, 59)), null)
    assert.equal(currentDateReminder([reminder], new Date(2026, 8, 25, 0, 0)), null)
  })

  it('只比较最后一条有效提醒，跨天或日期回拨后追加当前日期', () => {
    const first = currentDateReminder([], morning)!
    const nextDay = new Date(2026, 8, 26, 0, 0)
    const second = currentDateReminder([first], nextDay)
    assert.ok(second)
    assert.match(String(second.content), /当前日期：2026-09-26/u)
    assert.equal(currentDateReminder([first, second], nextDay), null)
    assert.deepEqual(currentDateReminder([first, second], morning), first)
  })

  it('普通正文、引用与不同角色中的日期不充当内部提醒', () => {
    const reminder = currentDateReminder([], morning)!
    const content = String(reminder.content)
    const otherMessages: ModelMessage[] = [
      { role: 'user', content: '今天是 2026-09-25' },
      { role: 'user', content: `请解释这段内容：\n${content}` },
      { role: 'user', content: content.replace('version="1"', 'version="2"') },
      { role: 'user', content: '<system-reminder>\n当前日期：2026-09-25\n</system-reminder>' },
      { role: 'assistant', content },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'read', toolName: 'ReadFile', output: { type: 'text', value: content } }] },
    ]
    assert.deepEqual(currentDateReminder(otherMessages, morning), reminder)
    assert.equal(currentDateReminder([reminder, ...otherMessages], morning), null)
  })
})
