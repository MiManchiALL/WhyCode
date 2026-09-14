import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationHistoryWindow, ConversationSnapshot } from '../../shared/conversation-history.ts'
import type { ConversationNavigationEntry } from '../../shared/conversation-navigation.ts'

interface HistoryPosition {
  runtimeId: string
  before: number | null
  earlierEntries: readonly ConversationNavigationEntry[]
}

interface HistoryLoad {
  pending: boolean
  result?: { firstBlockId: string; position: HistoryPosition; targetId?: string }
}

interface HistoryCallbacks {
  prepend: (pages: readonly ConversationSnapshot[], isCurrent: () => boolean) => void
  onError: (message: string) => void
}

/** 一个会话的历史加载事务；离开、历史改写和新的定位请求都撤销旧事务的写回资格。 */
export function useConversationHistory(callbacks: HistoryCallbacks) {
  const callbacksRef = useRef(callbacks)
  callbacksRef.current = callbacks
  const [position, setPosition] = useState<HistoryPosition>({ runtimeId: '', before: null, earlierEntries: [] })
  const positionRef = useRef(position)
  const requestRef = useRef<HistoryLoad | null>(null)

  useEffect(() => () => { requestRef.current = null }, [])

  const cancel = useCallback(() => {
    requestRef.current = null
  }, [])

  const reset = useCallback((runtimeId: string, history: ConversationHistoryWindow) => {
    cancel()
    const next = { runtimeId, before: history.before, earlierEntries: history.earlierEntries }
    positionRef.current = next
    setPosition(next)
  }, [cancel])

  const loadOlder = useCallback(async (targetId?: string) => {
    const initial = positionRef.current
    if (initial.before === null || (requestRef.current?.pending && !targetId)) return
    const request: HistoryLoad = { pending: true }
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
      request.result = { firstBlockId: pages.at(-1)!.blocks[0]!.id, position: next, targetId }
      startTransition(() => {
        callbacksRef.current.prepend(pages, () => requestRef.current === request)
        setPosition((previous) => requestRef.current === request ? next : previous)
      })
    } catch (error) {
      if (requestRef.current === request) {
        callbacksRef.current.onError(error instanceof Error ? error.message : String(error))
        request.pending = false
      }
    }
  }, [])

  // 补载事务在 DOM 提交后才完成，避免并发滚动跳过尚未显示的一页。
  const completeRender = useCallback((firstBlockId: string | undefined): { targetId?: string } | null => {
    const request = requestRef.current
    if (!request?.pending || !request.result) return {}
    if (request.result.firstBlockId !== firstBlockId) return null
    positionRef.current = request.result.position
    request.pending = false
    return { targetId: request.result.targetId }
  }, [])

  return {
    earlierEntries: position.earlierEntries,
    reset,
    cancel,
    loadOlder,
    completeRender,
  }
}
