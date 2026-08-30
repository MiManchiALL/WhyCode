import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { RuntimeEventBatch } from '../shared/session.ts'
import {
  RuntimeEventPortHub,
  type RuntimeEventPort,
} from './runtime-event-port-hub.ts'

class Port implements RuntimeEventPort {
  readonly messages: RuntimeEventBatch[] = []
  starts = 0
  closes = 0
  fail = false
  private closeListener: (() => void) | null = null

  start(): void { this.starts++ }

  close(): void {
    this.closes++
    this.closeListener?.()
  }

  once(event: 'close', listener: () => void): void {
    assert.equal(event, 'close')
    this.closeListener = listener
  }

  postMessage(message: RuntimeEventBatch): void {
    if (this.fail) throw new Error('port closed')
    this.messages.push(message)
  }
}

const batch = [{
  runtimeId: 'runtime-a',
  sessionId: 'session-a',
  sequence: 1,
  occurredAt: '2026-08-30T00:00:00.000Z',
  event: { type: 'text-delta' as const, text: 'hello' },
}]

describe('RuntimeEventPortHub', () => {
  it('长期端口只启动一次并接收完整有序批次', () => {
    const hub = new RuntimeEventPortHub()
    const port = new Port()
    hub.attach(1, port)

    hub.publish(batch)
    hub.publish(batch)

    assert.equal(port.starts, 1)
    assert.deepEqual(port.messages, [batch, batch])
  })

  it('同一页面重订阅时关闭旧端口，旧 close 回调不能移除新端口', () => {
    const hub = new RuntimeEventPortHub()
    const first = new Port()
    const second = new Port()
    hub.attach(1, first)
    hub.attach(1, second)

    assert.equal(first.closes, 1)
    hub.publish(batch)

    assert.deepEqual(first.messages, [])
    assert.deepEqual(second.messages, [batch])
  })

  it('单个失效端口不会阻断其它窗口，并在失败后立即移除', () => {
    const errors: unknown[] = []
    const hub = new RuntimeEventPortHub({ onPublishError: (error) => errors.push(error) })
    const failed = new Port()
    const healthy = new Port()
    failed.fail = true
    hub.attach(1, failed)
    hub.attach(2, healthy)

    hub.publish(batch)
    hub.publish(batch)

    assert.equal(errors.length, 1)
    assert.equal(failed.closes, 1)
    assert.deepEqual(healthy.messages, [batch, batch])
  })

  it('退出时关闭并移除全部端口', () => {
    const hub = new RuntimeEventPortHub()
    const first = new Port()
    const second = new Port()
    hub.attach(1, first)
    hub.attach(2, second)

    hub.closeAll()
    hub.publish(batch)

    assert.equal(first.closes, 1)
    assert.equal(second.closes, 1)
    assert.deepEqual(first.messages, [])
    assert.deepEqual(second.messages, [])
  })
})
