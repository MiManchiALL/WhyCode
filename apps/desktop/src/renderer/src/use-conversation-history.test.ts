import assert from 'node:assert/strict'
import { it, type TestContext } from 'node:test'
import type { ViewEvent } from '@whycode/core'
import { parseHTML } from 'linkedom'
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { conversationHistorySnapshot, conversationHistoryWindow } from '../../shared/conversation-window.ts'
import {
  restoreConversationSnapshot,
  type ConversationHistoryRequest, type ConversationHistoryResult, type ConversationHistorySnapshot,
} from '../../shared/conversation-history.ts'
import { applyCoreEvent, createConversationState } from '../../shared/conversation-state.ts'
import { useConversationHistory } from './use-conversation-history.ts'

const events: ViewEvent[] = Array.from({ length: 50 }, (_, index): ViewEvent[] => [
  { type: 'user-message', text: `问题 ${index}`, startsTurn: true, inputId: `input-${index}` },
  { type: 'core-event', event: { type: 'thinking-delta', text: '过程' } },
  { type: 'core-event', event: { type: 'work-finished', durationMs: 100, outcome: 'completed', forkTurnId: null } },
]).flat()
const full = createConversationState(events)
const tail = conversationHistorySnapshot(full)

it('连续上翻和下翻替换远端页，实时尾部能直接返回', async t => {
  const page = await fixture(t)
  for (let i = 0; i < 5; i++) await act(async () => { await page.history.read('older') })
  assert.ok(page.requests.every(r => r.location.kind === 'older'))
  assert.ok(page.history.after !== null)
  assert.ok(page.view.blocks.filter(block => block.kind === 'user').length <= 18)
  assert.ok(!page.view.blocks.includes(full.blocks.at(-1)!))
  await act(async () => { await page.history.read('newer') })
  assert.equal(page.requests.at(-1)?.location.kind, 'newer')
  await act(async () => { page.history.toTail() })
  assert.deepEqual(page.view.blocks, tail.view.blocks)
})

it('最新定位胜过迟到的滚动或另一次跳转，只请求目标窗口', async t => {
  let deliver!: (result: ConversationHistoryResult) => void
  const delayed = new Promise<ConversationHistoryResult>(resolve => { deliver = resolve })
  const target = full.blocks[4]!.id
  const page = await fixture(t, r => r.location.kind === 'older' ? delayed : readPage(r))
  await act(async () => {
    const older = page.history.read('older')
    await page.history.read({ around: target })
    deliver(readPage(page.requests[0]!))
    await older
  })
  assert.equal(page.requests.length, 2)
  assert.deepEqual(page.targets, [target])
  assert.ok(page.view.blocks.some(b => b.id === target))
  assert.equal(page.view.blocks.filter(b => b.kind === 'user').length, 6)
})

it('补载期间来的实时步骤和丢弃边界保持在尾部，阅读早期历史时也能接续', async t => {
  const page = await fixture(t)
  await act(async () => { await page.history.read('older') })
  await act(async () => { page.stream({ type: 'text-delta', text: '草稿' }) })
  assert.equal(page.view.blocks.at(-1)?.kind, 'text')
  await act(async () => { page.stream({ type: 'step-discarded' }) })
  assert.equal(page.view.blocks.at(-1)?.kind, 'work-duration')
  await act(async () => { await page.history.read({ around: full.blocks[0]!.id }) })
  await act(async () => { page.stream({ type: 'user-message-accepted', inputId: 'live', text: '新问题', startsTurn: true }) })
  assert.equal(page.view.blocks.some(b => b.kind === 'user' && b.inputId === 'live'), false)
  await act(async () => { page.history.toTail() })
  const last = page.view.blocks.at(-1)
  assert.equal(last?.kind === 'user' && last.text, '新问题')
})

it('只读预览移交后保留正在读的窗口，预览被撤销时恢复原会话', async t => {
  const page = await fixture(t)
  await act(async () => { page.history.reset('preview', tail, 'preview') })
  await act(async () => { await page.history.read({ around: full.blocks[0]!.id }) })
  const first = page.view.blocks[0]!.id
  await act(async () => { page.history.reset('preview', tail) })
  assert.equal(page.view.blocks[0]!.id, first)
  await act(async () => { page.history.reset('other', conversationHistorySnapshot(createConversationState()), 'preview') })
  await act(async () => { page.history.dismissPreview() })
  assert.equal(page.history.runtimeId, 'preview')
  assert.equal(page.view.blocks[0]!.id, first)
  await act(async () => { page.history.reset('new', tail, 'preview') })
  await act(async () => { page.history.reset('original', tail, 'background') })
  assert.equal(page.history.runtimeId, 'new')
  await act(async () => { page.history.dismissPreview() })
  assert.equal(page.history.runtimeId, 'original')
})

it('完整恢复期间发起的定位在同一运行时完成时仍然生效', async t => {
  let deliver!: (result: ConversationHistoryResult) => void
  const delayed = new Promise<ConversationHistoryResult>(resolve => { deliver = resolve })
  const page = await fixture(t, () => delayed)
  await act(async () => { page.history.reset('candidate', tail, 'preview') })
  await act(async () => {
    const pending = page.history.read({ around: full.blocks[0]!.id })
    page.history.reset('candidate', tail)
    deliver(readPage(page.requests[0]!))
    await pending
  })
  assert.equal(page.history.preview, null)
  assert.equal(page.view.blocks[0]!.id, full.blocks[0]!.id)
})

it('同一会话持续增长时释放较早尾部，保留全部导航项及当前锚点', async t => {
  const page = await fixture(t)
  const grown = createConversationState(events.slice(0, 39))
  const initial = conversationHistorySnapshot(createConversationState())
  await act(async () => { page.reset('growing', { ...initial, view: { ...grown, expanded: [], turnStartBlocks: [] } }) })
  await act(async () => { page.trim(grown.blocks[0]!.id) })
  assert.equal(page.view.blocks[0]!.id, grown.blocks[0]!.id)
  assert.equal(page.history.tail.blocks.filter(b => b.kind === 'user').length, 6)
  assert.equal(page.history.earlierEntries.length, 7)
  assert.ok(page.history.after !== null)
  await act(async () => { page.history.toTail() })
  assert.equal(page.view.blocks.at(-1)!.id, grown.blocks.at(-1)!.id)
})

it('切走后迟到的页不能改变已选会话', async t => {
  let deliver!: (result: ConversationHistoryResult) => void
  const delayed = new Promise<ConversationHistoryResult>(resolve => { deliver = resolve })
  const page = await fixture(t, () => delayed)
  await act(async () => {
    const pending = page.history.read('older')
    page.reset('other', conversationHistorySnapshot(createConversationState()))
    deliver(readPage(page.requests[0]!))
    await pending
  })
  assert.deepEqual(page.view.blocks, [])
})

function readPage(request: ConversationHistoryRequest): ConversationHistoryResult {
  return { ok: true, history: conversationHistoryWindow(full, request.location) }
}

async function fixture(
  t: TestContext,
  read: (request: ConversationHistoryRequest) => ConversationHistoryResult | Promise<ConversationHistoryResult> = readPage,
) {
  const { window, document } = parseHTML('<html><body></body></html>')
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true }
  const originals = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  const requests: ConversationHistoryRequest[] = []
  const targets: string[] = []
  Object.defineProperty(window, 'whycode', {
    configurable: true,
    value: {
      conversationHistory(request: ConversationHistoryRequest) {
        requests.push(request)
        return read(request)
      },
    },
  })
  let history!: ReturnType<typeof useConversationHistory>
  let reset!: (id: string, snapshot: ConversationHistorySnapshot) => void
  let trim!: (anchor: string) => void
  let stream!: (event: Parameters<typeof applyCoreEvent>[1]) => void
  function Conversation() {
    const [live, setLive] = useState(() => restoreConversationSnapshot(tail.view))
    history = useConversationHistory(live, {
      beforePage: location => { if (location.kind === 'around') targets.push(location.id) },
      onError: message => assert.fail(message),
    })
    reset = (id, snapshot) => {
      history.reset(id, snapshot)
      setLive(restoreConversationSnapshot(snapshot.view))
    }
    trim = anchor => setLive(history.trimLive(live, history.view, anchor))
    stream = event => setLive(current => applyCoreEvent(current, event))
    return null
  }
  const root = createRoot(document.body)
  t.after(async () => {
    await act(() => root.unmount())
    Reflect.deleteProperty(window, 'whycode')
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  await act(() => root.render(createElement(Conversation)))
  await act(() => reset('long', tail))
  return { get history() { return history }, get view() { return history.view }, requests, targets, reset, stream, trim: (anchor: string) => trim(anchor) }
}
