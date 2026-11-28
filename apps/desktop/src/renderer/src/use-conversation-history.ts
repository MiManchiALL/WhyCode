import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  conversationSnapshotRange, prependConversationHistory, restoreConversationSnapshot,
  type ConversationHistorySnapshot, type ConversationHistoryWindow, type HistoryLocation,
} from '../../shared/conversation-history.ts'
import { conversationHistorySnapshot, conversationReadingWindow } from '../../shared/conversation-window.ts'
import type { ConversationState } from '../../shared/conversation-state.ts'

interface Position {
  runtimeId: string
  tailBefore: number | null
  earlierEntries: ConversationHistorySnapshot['earlierEntries']
  reading?: ConversationHistoryWindow
  preview: ConversationState | null
}

function windowStart(position: Position): number | null {
  const { reading, tailBefore } = position
  if (!reading) return tailBefore
  if (reading.after !== null) return reading.before
  return Math.min(reading.before ?? 0, tailBefore ?? 0) || null
}

const empty: Position = { runtimeId: '', tailBefore: null, earlierEntries: [], preview: null }

export function useConversationHistory(live: ConversationState, callbacks: {
  beforePage: (location: HistoryLocation) => boolean | void
  onError: (message: string) => void
}) {
  const [position, setPosition] = useState(empty)
  const current = useRef(position)
  const previous = useRef<Position | null>(null)
  const request = useRef<HistoryLocation | null>(null)
  const handlers = useRef(callbacks)
  handlers.current = callbacks
  const cancel = useCallback(() => { request.current = null }, [])
  useEffect(() => cancel, [cancel])

  const replace = useCallback((next: Position) => {
    current.current = next
    setPosition(next)
  }, [])
  const reset = useCallback((runtimeId: string, snapshot: ConversationHistorySnapshot, mode: 'selected' | 'preview' | 'background' = 'selected') => {
    const active = current.current
    const promoting = mode === 'selected' && !!active.preview && active.runtimeId === runtimeId
    const next = {
      runtimeId, tailBefore: snapshot.before, earlierEntries: snapshot.earlierEntries,
      reading: promoting ? active.reading : snapshot.reading,
      preview: mode === 'preview' ? restoreConversationSnapshot(snapshot.view) : null,
    }
    if (mode === 'background') {
      previous.current = next
      return
    }
    if (!promoting) cancel()
    if (mode === 'preview') previous.current ??= active
    else previous.current = null
    replace(next)
  }, [cancel, replace])
  const dismissPreview = useCallback(() => {
    if (!previous.current) return
    cancel()
    replace(previous.current)
    previous.current = null
  }, [cancel, replace])

  const read = useCallback(async (direction: 'older' | 'newer' | { around: string }) => {
    const active = current.current
    let location: HistoryLocation
    if (typeof direction === 'object') {
      location = { kind: 'around', id: direction.around }
    } else {
      if (request.current?.kind === direction || request.current?.kind === 'around') return
      const cursor = direction === 'older'
        ? windowStart(active)
        : active.reading?.after
      if (cursor == null) return
      location = { kind: direction, cursor }
    }
    request.current = location
    try {
      const result = await window.whycode.conversationHistory({ runtimeId: active.runtimeId, location })
      if (request.current !== location) return
      if (!result.ok) throw new Error(result.error)
      // 在提交当刻取锚，layout effect 在下一次滚轮输入前恢复同一段和像素偏移。
      if (handlers.current.beforePage(location) === false) return
      flushSync(() => replace({ ...current.current, reading: result.history }))
    } catch (error) {
      if (request.current === location) handlers.current.onError(error instanceof Error ? error.message : String(error))
    } finally {
      if (request.current === location) request.current = null
    }
  }, [replace])

  const toTail = useCallback(() => {
    cancel()
    if (current.current.reading) flushSync(() => replace({ ...current.current, reading: undefined }))
  }, [cancel, replace])
  const tail = position.preview ?? live
  const view = useMemo(() => {
    const page = position.reading
    if (!page) return tail
    const history = restoreConversationSnapshot(page.view)
    if (page.after !== null) return history
    const prefix = (position.tailBefore ?? 0) - (page.before ?? 0)
    return prefix > 0 ? prependConversationHistory(tail, conversationSnapshotRange(history, 0, prefix)) : tail
  }, [position.reading, position.tailBefore, tail])
  const trimLive = useCallback((liveView: ConversationState, displayed: ConversationState, anchor?: string) => {
    const active = current.current
    const tail = conversationHistorySnapshot(liveView)
    const offset = active.tailBefore ?? 0
    let reading = active.reading
    if (reading?.after == null) {
      const start = windowStart(active) ?? 0
      const local = anchor ? conversationReadingWindow(displayed, anchor) : undefined
      reading = local && { ...local, before: (start + (local.before ?? 0)) || null,
        after: local.after === null ? null : start + local.after }
    }
    cancel()
    replace({ ...active, tailBefore: offset + (tail.before ?? 0), reading,
      earlierEntries: [...active.earlierEntries, ...tail.earlierEntries] })
    return restoreConversationSnapshot(tail.view)
  }, [cancel, replace])
  return {
    ...position, trimLive, tail, view, before: windowStart(position),
    after: position.reading?.after ?? null, read, toTail, reset, dismissPreview, cancel,
  }
}
