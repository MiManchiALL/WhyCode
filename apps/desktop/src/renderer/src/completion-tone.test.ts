import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CompletionTone } from './completion-tone.ts'

describe('完成提示音资源', () => {
  it('重叠完成只播放一次，结束后释放节点和设备，再次完成可以重建', async () => {
    const fixture = audioFixture()
    await Promise.all([fixture.tone.play(), fixture.tone.play()])
    assert.equal(fixture.devices.length, 1)
    const device = fixture.devices[0]!
    assert.equal(device.started, 1)
    assert.ok(device.endAt > device.currentTime && device.endAt < device.currentTime + 1)
    device.oscillator.onended?.()
    assert.equal(device.closed, 1)
    assert.equal(device.disconnected, 2)
    await fixture.tone.play()
    assert.equal(fixture.devices.length, 2)
    fixture.tone.stop()
    fixture.tone.stop()
    assert.equal(fixture.devices[1]!.closed, 1)
  })
  it('设备启动期间取消，不会迟到播放或关闭下一次的设备', async () => {
    const fixture = audioFixture(true)
    const first = fixture.tone.play()
    fixture.tone.stop()
    const second = fixture.tone.play()
    fixture.devices[0]!.ready.resolve()
    await first
    assert.equal(fixture.devices[0]!.started, 0)
    fixture.devices[1]!.ready.resolve()
    await second
    assert.equal(fixture.devices[1]!.started, 1)
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
  const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }
  const value = {
    ready, closed: 0, disconnected: 0, started: 0, endAt: 0, currentTime: 4, state: 'running', destination: {},
    resume: () => ready.promise,
    close: async () => { value.closed++; value.state = 'closed' },
    createOscillator: () => value.oscillator,
    createGain: () => ({ gain: param, connect() {}, disconnect() { value.disconnected++ } }),
    oscillator: { type: '', frequency: param, onended: null as (() => void) | null, connect() {},
      disconnect() { value.disconnected++ }, start() { value.started++ }, stop(time: number) { value.endAt = time } },
  }
  return value
}
