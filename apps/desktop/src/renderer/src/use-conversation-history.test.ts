import assert from 'node:assert/strict'
import { it, type TestContext } from 'node:test'
import type { ViewEvent } from '@whycode/core'
import { parseHTML } from 'linkedom'
import { act, createElement, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { conversationHistoryWindow } from '../../main/conversation-history.ts'
import {
  prependConversationHistory, restoreConversationSnapshot,
  type ConversationHistoryRequest, type ConversationHistoryResult, type ConversationHistoryWindow,
} from '../../shared/conversation-history.ts'
import { conversationNavigationEntries } from '../../shared/conversation-navigation.ts'
import { conversationSections } from '../../shared/conversation-sections.ts'
import { createConversationState, type ConversationState } from '../../shared/conversation-state.ts'
import { useConversationHistory } from './use-conversation-history.ts'

const events: ViewEvent[] = Array.from({ length: 50 }, (_, index): ViewEvent[] => [
  { type: 'user-message', text: `问题 ${index}`, startsTurn: true, inputId: `input-${index}` },
  { type: 'core-event', event: { type: 'thinking-delta', text: '过程' } },
  { type: 'core-event', event: { type: 'work-finished', durationMs: 100, outcome: 'completed', forkTurnId: null } },
]).flat()
const full = createConversationState(events)
const tail = conversationHistoryWindow(full)
const firstPage = conversationHistoryWindow(full, { before: tail.before! })

it('滚动补页与定位发生在同一次绘制前时，正文和定位轨都只接收一次历史', async t => {
  const page = await fixture(t)
  const target = full.blocks[0]!.id
  await act(async () => {
    await page.history.loadOlder()
    await page.history.loadOlder(target)
  })
  assert.deepEqual(page.requests.map(request => request.before), [tail.before, firstPage.before])
  assert.deepEqual(page.view.blocks, full.blocks)
  const markers = [...page.history.earlierEntries, ...conversationNavigationEntries(conversationSections(page.view.blocks))]
  assert.deepEqual(markers, conversationNavigationEntries(conversationSections(full.blocks)))
  assert.deepEqual(page.targets, [target])
})

it('定位到已接收但尚未绘制的页时复用该页，绘制后只跳转到最后选择的目标', async t => {
  const oldest = full.blocks[0]!.id
  let release!: () => void
  const delayed = new Promise<void>(resolve => { release = resolve })
  const page = await fixture(t, async request => {
    if (request.targetId === oldest) await delayed
    return readPage(request)
  })
  const [first, second] = firstPage.view.blocks.filter(block => block.kind === 'user')
  await act(async () => {
    await page.history.loadOlder()
    const older = page.history.loadOlder(oldest)
    await page.history.loadOlder(first!.id)
    await page.history.loadOlder(second!.id)
    release()
    await older
  })
  assert.deepEqual(page.requests.map(request => request.targetId), [undefined, oldest])
  assert.equal(page.view.blocks[0]!.id, firstPage.view.blocks[0]!.id)
  assert.deepEqual(page.targets, [second!.id])
})

it('切到新会话后，上一会话已接收的页和迟到的读取结果都不能带入新会话', async t => {
  let deliver!: (result: ConversationHistoryResult) => void
  const delayed = new Promise<ConversationHistoryResult>(resolve => { deliver = resolve })
  const page = await fixture(t, request => request.targetId ? delayed : readPage(request))
  let pending!: Promise<void>
  await act(async () => {
    await page.history.loadOlder()
    pending = page.history.loadOlder(full.blocks[0]!.id)
    page.reset('new', conversationHistoryWindow(createConversationState()))
  })
  await act(async () => {
    deliver(readPage(page.requests[1]!))
    await pending
  })
  assert.deepEqual(page.view.blocks, [])
  assert.deepEqual(page.history.earlierEntries, [])
  assert.deepEqual(page.targets, [])
})

function readPage(request: ConversationHistoryRequest): ConversationHistoryResult {
  return { ok: true, history: conversationHistoryWindow(full, request) }
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
  let view!: ConversationState
  let reset!: (runtimeId: string, snapshot: ConversationHistoryWindow) => void
  function Conversation() {
    const [current, setView] = useState(() => restoreConversationSnapshot(tail.view))
    view = current
    history = useConversationHistory({
      prepend: pages => setView(previous => pages.reduce(prependConversationHistory, previous)),
      onError: message => assert.fail(message),
    })
    reset = (runtimeId, snapshot) => {
      history.reset(runtimeId, snapshot)
      setView(restoreConversationSnapshot(snapshot.view))
    }
    useLayoutEffect(() => {
      const target = history.completeRender(current.blocks[0]?.id)?.targetId
      if (target) targets.push(target)
    }, [current])
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
  return { get history() { return history }, get view() { return view }, requests, targets, reset }
}
