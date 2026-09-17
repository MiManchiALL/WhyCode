import assert from 'node:assert/strict'
import { afterEach, it } from 'node:test'
import { requestHighlight, type HighlightRequest, type HighlightResponse, type HighlightedLines } from './syntax-highlighting.ts'

class TestWorker {
  static instances: TestWorker[] = []
  onmessage: ((event: { data: HighlightResponse }) => void) | null = null
  onerror: (() => void) | null = null
  requests: HighlightRequest[] = []
  terminated = false
  constructor() { TestWorker.instances.push(this) }
  postMessage(request: HighlightRequest) { this.requests.push(request) }
  terminate() { this.terminated = true }
  deliver(id: number, content: string) {
    this.onmessage?.({ data: { id, lines: [content] } })
  }
}
const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
const disposers: (() => void)[] = []
afterEach(() => {
  disposers.splice(0).forEach(dispose => dispose())
  if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker)
  else Reflect.deleteProperty(globalThis, 'Worker')
  TestWorker.instances = []
})
function setup() {
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: TestWorker })
}
function request(path: string, source: string, receive: (lines: HighlightedLines) => void = () => {}) {
  const dispose = requestHighlight(path, source, receive)
  disposers.push(dispose)
  return () => { disposers.splice(disposers.indexOf(dispose), 1); dispose() }
}

it('visible code views share a worker and route results to the requesting view', () => {
  setup()
  const results: string[] = []
  const closeA = request('a.html', '<h1>A</h1>', lines => results.push('A:' + lines[0]))
  request('b.ts', 'const b = 1', lines => results.push('B:' + lines[0]))
  assert.equal(TestWorker.instances.length, 1)
  const worker = TestWorker.instances[0]!
  worker.deliver(worker.requests[1]!.id, 'b')
  worker.deliver(worker.requests[0]!.id, 'a')
  assert.deepEqual(results, ['B:b', 'A:a'])
  closeA()
  assert.equal(worker.terminated, false)
})

it('closing or replacing a view cancels its result; closing the last view releases all work', () => {
  setup()
  const results: string[] = []
  const closeA = request('a.html', 'old', () => results.push('old'))
  const closeB = request('b.html', 'current', () => results.push('current'))
  const worker = TestWorker.instances[0]!
  const oldId = worker.requests[0]!.id
  const currentId = worker.requests[1]!.id
  closeA()
  assert.deepEqual(worker.requests.at(-1), { type: 'cancel', id: oldId })
  worker.deliver(oldId, 'late')
  worker.deliver(currentId, 'current')
  assert.deepEqual(results, ['current'])
  closeB()
  assert.equal(worker.terminated, true)
  request('a.html', 'reopen')
  assert.equal(TestWorker.instances.length, 2)
})

it('plain text and oversized source do not start a worker; failed workers can be released and reopened', () => {
  setup()
  request('notes.txt', 'text')
  request('constructor', 'text')
  request('notes.__proto__', 'text')
  request('large.html', 'x'.repeat(160_001))
  assert.equal(TestWorker.instances.length, 0)
  const close = request('a.html', 'a', () => assert.fail('failed worker must not deliver'))
  const failed = TestWorker.instances[0]!
  failed.onerror?.()
  failed.deliver(failed.requests[0]!.id, 'late')
  request('b.html', 'b')
  close()
  assert.equal(failed.terminated, true)
  assert.equal(TestWorker.instances[1]!.terminated, false)
})
