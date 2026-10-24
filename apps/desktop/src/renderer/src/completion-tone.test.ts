import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CompletionTone } from './completion-tone.ts'

describe('完成提示音资源', () => {
  it('冷启动留出设备预热时间，重叠完成合并，短暂空闲复用，长期空闲释放设备', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const fixture = audioFixture()
    await Promise.all([fixture.tone.play(), fixture.tone.play()])
    assert.equal(fixture.devices.length, 1)
    const device = fixture.devices[0]!
    assert.equal(device.oscillators.length, 2)
    assert.equal(device.oscillators[0]!.startAt, device.currentTime + 0.5)
    device.currentTime = 5
    for (const oscillator of device.oscillators) oscillator.onended?.()
    assert.equal(device.disconnected, 4)
    assert.equal(device.closed, 0)
    t.mock.timers.tick(1000)
    assert.equal(device.closed, 0, '短音结束不立即关闭蓝牙输出')
    device.currentTime = 6
    await fixture.tone.play()
    assert.equal(fixture.devices.length, 1)
    assert.equal(device.resumed, 2)
    assert.equal(device.oscillators.length, 4)
    assert.equal(device.oscillators[2]!.startAt, 6.01, '已就绪设备立即重播')
    device.currentTime = 7
    device.oscillators.slice(2).forEach(note => note.onended?.())
    t.mock.timers.tick(9999)
    assert.equal(device.closed, 0)
    t.mock.timers.tick(1)
    assert.equal(device.closed, 1, '空闲设备必须释放')
    await fixture.tone.play()
    assert.equal(fixture.devices.length, 2)
    assert.equal(fixture.devices[1]!.oscillators[0]!.startAt, 4.5, '长时间空闲后重新预热')
    fixture.tone.stop()
    fixture.tone.stop()
    assert.equal(device.closed, 1)
    assert.equal(device.disconnected, 8)
    assert.equal(fixture.devices[1]!.closed, 1)
  })
  it('连续试听不推迟设备就绪时刻，旧音平滑停止；旧回调和空闲定时器不关闭新音', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { tone, devices } = audioFixture()
    await tone.play(true)
    const device = devices[0]!
    const oldNotes = [...device.oscillators]
    device.currentTime += 0.2
    await tone.play(true)
    assert.equal(devices.length, 1)
    assert.equal(device.oscillators.length, 4, '试听不能被自动通知的合并逻辑丢弃')
    assert.equal(device.oscillators[2]!.startAt, 4.5, '预热中的连点不延长等待')
    assert.ok(oldNotes.every(note => note.endAt === device.currentTime + 0.006))
    assert.equal(device.held, 2)
    oldNotes.forEach(note => note.onended?.())
    t.mock.timers.tick(10000)
    assert.equal(device.closed, 0)
    device.currentTime = 5
    device.oscillators.slice(2).forEach(note => note.onended?.())
    t.mock.timers.tick(9000)
    device.currentTime = 14
    await tone.play(true)
    t.mock.timers.tick(11000)
    assert.equal(device.closed, 0)
    tone.stop()
    t.mock.timers.tick(10000)
    assert.equal(device.closed, 1)
    assert.equal(device.disconnected, 12)
  })
  it('后台空闲计时器迟到时仍重新启动设备，系统暂停后也重新预热', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { tone, devices } = audioFixture()
    await tone.play()
    const first = devices[0]!
    first.currentTime = 5
    first.oscillators.forEach(note => note.onended?.())
    first.currentTime = 40
    await tone.play()
    assert.equal(first.closed, 1)
    const second = devices[1]!
    assert.equal(second.oscillators[0]!.startAt, 4.5)
    second.currentTime = 5
    second.oscillators.forEach(note => note.onended?.())
    second.state = 'suspended'
    await tone.play()
    assert.equal(second.oscillators[2]!.startAt, 5.5)
    tone.stop()
  })
  it('设备未就绪时多次试听只保留最新一次，仍能继续正常播放', async () => {
    const { tone, devices } = audioFixture(true)
    const first = tone.play(true)
    const second = tone.play(true)
    assert.equal(devices.length, 1)
    devices[0]!.ready.resolve()
    await Promise.all([first, second])
    assert.equal(devices[0]!.oscillators.length, 2)
    await tone.play(true)
    assert.equal(devices[0]!.oscillators.length, 4)
    tone.stop()
  })
  it('设备启动期间取消，不会迟到播放或关闭下一次的设备', async () => {
    const fixture = audioFixture(true)
    const first = fixture.tone.play()
    fixture.tone.stop()
    const second = fixture.tone.play()
    fixture.devices[0]!.ready.resolve()
    await first
    assert.equal(fixture.devices[0]!.oscillators.length, 0)
    fixture.devices[1]!.ready.resolve()
    await second
    assert.equal(fixture.devices[1]!.oscillators.length, 2)
    assert.equal(fixture.devices[1]!.closed, 0)
    fixture.tone.stop()
  })
  it('设备失败向调用方报告并释放，后续仍可重试；取消引起的失败不误报', async () => {
    const fixture = audioFixture(true)
    const first = fixture.tone.play()
    fixture.devices[0]!.ready.reject(new Error('device unavailable'))
    await assert.rejects(first, /device unavailable/u)
    assert.equal(fixture.devices[0]!.closed, 1)
    const second = fixture.tone.play()
    fixture.tone.stop()
    fixture.devices[1]!.ready.reject(new Error('closed'))
    await second
    const third = fixture.tone.play()
    fixture.devices[2]!.ready.resolve()
    await third
    fixture.tone.stop()
  })
  it('创建音频设备失败不会卡住后续试听', async () => {
    const context = device(false)
    let attempt = 0
    const tone = new CompletionTone(() => {
      if (++attempt === 1) throw new Error('device unavailable')
      return context as unknown as AudioContext
    })
    await assert.rejects(tone.play(true), /device unavailable/u)
    await tone.play(true)
    assert.equal(context.oscillators.length, 2)
    tone.stop()
  })
})

function audioFixture(pending = false) {
  const devices: ReturnType<typeof device>[] = []
  const tone = new CompletionTone(() => {
    const next = device(pending)
    devices.push(next)
    return next as unknown as AudioContext
  })
  return { tone, devices }
}
function device(pending: boolean) {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const ready = { promise, resolve, reject }
  if (!pending) ready.resolve()
  const oscillators: { type: string; frequency: typeof param; onended: (() => void) | null; startAt: number; endAt: number;
    connect: () => void; disconnect: () => void; start: (time: number) => void; stop: (time: number) => void }[] = []
  const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {},
    cancelAndHoldAtTime() { value.held++ } }
  const value = {
    ready, oscillators, closed: 0, disconnected: 0, held: 0, resumed: 0,
    currentTime: 4, state: 'running', destination: {},
    resume: () => { value.resumed++; value.state = 'running'; return ready.promise },
    close: async () => { value.closed++; value.state = 'closed' },
    createOscillator: () => {
      const oscillator = { type: '', frequency: param, onended: null as (() => void) | null, startAt: 0, endAt: 0, connect() {},
        disconnect() { value.disconnected++ }, start(time: number) { oscillator.startAt = time }, stop(time: number) { oscillator.endAt = time } }
      oscillators.push(oscillator)
      return oscillator
    },
    createGain: () => ({ gain: param, connect() {}, disconnect() { value.disconnected++ } }),
  }
  return value
}
