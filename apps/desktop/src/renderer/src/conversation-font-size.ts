import { useCallback, useState } from 'react'

export const CONVERSATION_FONT_SIZE = { min: 12, max: 17, default: 14 } as const
const STORAGE_KEY = 'whycode:conversation-font-size'

function loadFontSize(): number {
  try {
    const value = Number(globalThis.localStorage.getItem(STORAGE_KEY))
    if (Number.isInteger(value) && value >= CONVERSATION_FONT_SIZE.min && value <= CONVERSATION_FONT_SIZE.max) return value
  } catch {}
  return CONVERSATION_FONT_SIZE.default
}

export function useConversationFontSize() {
  const [fontSize, setFontSize] = useState(loadFontSize)
  const update = useCallback((value: number) => {
    if (!Number.isInteger(value) || value < CONVERSATION_FONT_SIZE.min || value > CONVERSATION_FONT_SIZE.max) return
    setFontSize(value)
    try {
      globalThis.localStorage.setItem(STORAGE_KEY, String(value))
    } catch {
      // 存储不可用时，当前窗口的字号选择仍然生效。
    }
  }, [])
  return [fontSize, update] as const
}
