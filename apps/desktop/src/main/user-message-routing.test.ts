import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { routeUserMessage, UserMessageRoutingGate } from './user-message-routing.ts'

describe('桌面输入权威路由', () => {
  it('快速 A/B 只有第一条建立根消息，第二条按运行中输入交付', async () => {
    let busy = false
    const gate = new UserMessageRoutingGate()
    let releaseFirstRecord: (() => void) | null = null
    const records: { inputId: string; text: string; startsTurn: boolean }[] = []
    const accepted: string[] = []
    const delivered: string[] = []
    const route = {
      isBusy: () => busy,
      reserve: () => gate.reserve(),
      record: async (inputId: string, text: string, startsTurn: boolean) => {
        records.push({ inputId, text, startsTurn })
        if (text === 'A') await new Promise<void>((resolve) => { releaseFirstRecord = resolve })
      },
      acceptRoot: (text: string) => accepted.push(text),
      deliver: (_inputId: string, text: string) => {
        delivered.push(text)
        busy = true
      },
    }

    const first = routeUserMessage('A', false, route)
    const second = routeUserMessage('B', false, route)
    await Promise.resolve()
    releaseFirstRecord!()
    assert.deepEqual(await Promise.all([first, second]), [true, false])
    assert.equal(records.length, 2)
    assert.deepEqual(records.map(({ text, startsTurn }) => ({ text, startsTurn })), [
      { text: 'A', startsTurn: true },
      { text: 'B', startsTurn: false },
    ])
    assert.notEqual(records[0]?.inputId, records[1]?.inputId)
    assert.deepEqual(accepted, ['A'])
    assert.deepEqual(delivered, ['A', 'B'])
    assert.equal(gate.busy, false)
  })

  it('压缩或回滚等非 turn 忙碌期不会乐观显示根消息', async () => {
    const accepted: string[] = []
    let recordedStartsTurn: boolean | null = null

    const startsTurn = await routeUserMessage('排队消息', false, {
      isBusy: () => true,
      reserve: () => ({ ready: Promise.resolve(), release: () => {} }),
      record: async (_inputId, _text, root) => { recordedStartsTurn = root },
      acceptRoot: (text) => accepted.push(text),
      deliver: () => {},
    })

    assert.equal(startsTurn, false)
    assert.equal(recordedStartsTurn, false)
    assert.deepEqual(accepted, [])
  })

  it('持久化失败时不显示也不交付消息，并释放同步占位', async () => {
    const gate = new UserMessageRoutingGate()
    let accepted = false
    let delivered = false
    await assert.rejects(
      routeUserMessage('不能提前交付', false, {
        isBusy: () => false,
        reserve: () => gate.reserve(),
        record: async () => { throw new Error('disk full') },
        acceptRoot: () => { accepted = true },
        deliver: () => { delivered = true },
      }),
      /disk full/,
    )
    assert.equal(accepted, false)
    assert.equal(delivered, false)
    assert.equal(gate.busy, false)
  })

  it('前一条在交付前失败时，已排队的后一条会重新判断并成为根消息', async () => {
    const gate = new UserMessageRoutingGate()
    const firstReservation = gate.reserve()
    const secondReservation = gate.reserve()
    const delivered: string[] = []
    const route = {
      isBusy: () => false,
      reserve: () => gate.reserve(),
      record: async (_inputId: string, text: string) => {
        if (text === '失败') throw new Error('prepare failed')
      },
      acceptRoot: () => {},
      deliver: (_inputId: string, text: string) => { delivered.push(text) },
    }

    const first = routeUserMessage('失败', false, route, firstReservation)
    const second = routeUserMessage('继续', false, route, secondReservation)
    await assert.rejects(first, /prepare failed/)
    assert.equal(await second, true)
    assert.deepEqual(delivered, ['继续'])
    assert.equal(gate.busy, false)
  })

  it('交给 Agent 后立即确认，不等待完整模型回合', async () => {
    const gate = new UserMessageRoutingGate()
    let finishTurn!: () => void
    const turn = new Promise<void>((resolve) => { finishTurn = resolve })
    let completed = false
    turn.then(() => { completed = true }).catch(() => {})

    assert.equal(await routeUserMessage('开始长任务', false, {
      isBusy: () => false,
      reserve: () => gate.reserve(),
      record: async () => {},
      acceptRoot: () => {},
      deliver: () => turn,
    }), true)
    assert.equal(completed, false)
    assert.equal(gate.busy, false)
    finishTurn()
    await turn
  })

  it('异步交付异常经回调上报且不会形成未处理拒绝', async () => {
    const gate = new UserMessageRoutingGate()
    const reported: unknown[] = []
    await routeUserMessage('触发异常', false, {
      isBusy: () => false,
      reserve: () => gate.reserve(),
      record: async () => {},
      acceptRoot: () => {},
      deliver: async () => { throw new Error('runtime failure') },
      onDeliveryError: (error) => reported.push(error),
    })
    await Promise.resolve()
    assert.equal((reported[0] as Error | undefined)?.message, 'runtime failure')
  })

  it('输入写稳后的同步交付异常只上报运行时错误，不伪装成发送失败', async () => {
    const gate = new UserMessageRoutingGate()
    const reported: unknown[] = []
    let recorded = false

    assert.equal(await routeUserMessage('已经持久化', false, {
      isBusy: () => false,
      reserve: () => gate.reserve(),
      record: async () => { recorded = true },
      acceptRoot: () => {},
      deliver: () => { throw new Error('sync runtime failure') },
      onDeliveryError: (error) => reported.push(error),
    }), true)

    assert.equal(recorded, true)
    assert.equal((reported[0] as Error | undefined)?.message, 'sync runtime failure')
    assert.equal(gate.busy, false)
  })
})
