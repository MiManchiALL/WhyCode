import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { routeUserMessage } from './user-message-routing.ts'

describe('桌面输入权威路由', () => {
  it('快速 A/B 只有第一条建立根消息，第二条按运行中输入交付', async () => {
    let busy = false
    const records: { text: string; startsTurn: boolean }[] = []
    const accepted: string[] = []
    const delivered: string[] = []
    const route = {
      isBusy: () => busy,
      record: async (text: string, startsTurn: boolean) => {
        records.push({ text, startsTurn })
      },
      acceptRoot: (text: string) => accepted.push(text),
      deliver: (text: string) => {
        delivered.push(text)
        busy = true
      },
    }

    const first = routeUserMessage('A', false, route)
    const second = routeUserMessage('B', false, route)
    assert.deepEqual(await Promise.all([first, second]), [true, false])
    assert.deepEqual(records, [
      { text: 'A', startsTurn: true },
      { text: 'B', startsTurn: false },
    ])
    assert.deepEqual(accepted, ['A'])
    assert.deepEqual(delivered, ['A', 'B'])
  })

  it('压缩或回滚等非 turn 忙碌期不会乐观显示根消息', async () => {
    const accepted: string[] = []
    let recordedStartsTurn: boolean | null = null

    const startsTurn = await routeUserMessage('排队消息', false, {
      isBusy: () => true,
      record: async (_text, root) => { recordedStartsTurn = root },
      acceptRoot: (text) => accepted.push(text),
      deliver: () => {},
    })

    assert.equal(startsTurn, false)
    assert.equal(recordedStartsTurn, false)
    assert.deepEqual(accepted, [])
  })
})
