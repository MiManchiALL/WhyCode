import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationHistoryWindow, ConversationSnapshot } from '../../shared/conversation-history.ts'
import type { ConversationNavigationEntry } from '../../shared/conversation-navigation.ts'

interface HistoryPosition {
  runtimeId: string
  before: number | null
  earlierEntries: readonly ConversationNavigationEntry[]
}

interface HistoryCallbacks {
  prepend: (pages: readonly ConversationSnapshot[]) => void
  onError: (message: string) => void
}

/** 会话或定位目标变化时，丢弃尚未接收的读取结果和过期的滚动目标。 */
export function useConversationHistory(callbacks: HistoryCallbacks) {
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks
  const [position, setPosition] = useState<HistoryPosition>({ runtimeId: '', before: null, earlierEntries: [] })
  const positionRef = useRef(position)
  const requestRef = useRef<symbol | null>(null)
  const pendingRenderRef = useRef<{ firstBlockId: string; targetId?: string } | null>(null)

  const cancel = useCallback(() => {
    requestRef.current = null
    pendingRenderRef.current = null
  }, [])
  useEffect(() => cancel, [cancel])

  const reset = useCallback((runtimeId: string, history: ConversationHistoryWindow) => {
    cancel()
    const next = { runtimeId, before: history.before, earlierEntries: history.earlierEntries }
    positionRef.current = next
    setPosition(next)
  }, [cancel])

  const loadOlder = useCallback(async (targetId?: string) => {
    const initial = positionRef.current
    const pendingRender = pendingRenderRef.current
    if (targetId && pendingRender) {
      if (!initial.earlierEntries.some(entry => entry.id === targetId)) {
        requestRef.current = null
        pendingRender.targetId = targetId
        return
      }
      delete pendingRender.targetId
    }
    if (initial.before === null || (!targetId && (requestRef.current || pendingRender))) return
    const request = Symbol()
    requestRef.current = request
    const pages: ConversationSnapshot[] = []
    let before: number | null = initial.before
    let earlierEntries = initial.earlierEntries
    try {
      do {
        const result = await window.whycode.conversationHistory({
          runtimeId: initial.runtimeId,
          before,
          ...(targetId ? { targetId } : {}),
        })
        if (requestRef.current !== request) return
        if (!result.ok) throw new Error(result.error)
        const page = result.history
        if (page.view.blocks.length === 0 || page.before === before) {
          throw new Error('未能读取更早的消息，请稍后重试')
        }
        pages.push(page.view)
        before = page.before
        earlierEntries = page.earlierEntries
        if (!targetId || page.view.blocks.some((block) => block.id === targetId)) break
      } while (before)
      const next = { runtimeId: initial.runtimeId, before, earlierEntries }
      // 页面一经接收，后续请求就从新边界读取。只有滚动定位需要等待 DOM。
      positionRef.current = next
      pendingRenderRef.current = { firstBlockId: pages.at(-1)!.blocks[0]!.id, targetId }
      startTransition(() => {
        callbacksRef.current.prepend(pages)
        setPosition(next)
      })
    } catch (error) {
      if (requestRef.current === request) {
        callbacksRef.current.onError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (requestRef.current === request) requestRef.current = null
    }
  }, [])

  const completeRender = useCallback((firstBlockId: string | undefined): { targetId?: string } | null => {
    const pending = pendingRenderRef.current
    if (!pending) return {}
    if (pending.firstBlockId !== firstBlockId) return null
    pendingRenderRef.current = null
    return { targetId: pending.targetId }
  }, [])

  return {
    earlierEntries: position.earlierEntries,
    reset,
    cancel,
    loadOlder,
    completeRender,
  }
}
