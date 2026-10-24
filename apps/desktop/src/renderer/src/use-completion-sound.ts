import { useCallback, useEffect, useRef, useState } from 'react'
import { CompletionTone } from './completion-tone.ts'

const STORAGE_KEY = 'whycode:completion-sound'

export interface CompletionSoundSetting {
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  preview: () => void
}

export function useCompletionSound() {
  const [enabled, setPreference] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) === 'true' } catch { return false }
  })
  const enabledRef = useRef(enabled)
  const tone = useRef<CompletionTone | null>(null)
  useEffect(() => () => tone.current?.stop(), [])

  const setEnabled = useCallback((value: boolean) => {
    enabledRef.current = value
    setPreference(value)
    if (!value) tone.current?.stop()
    try { localStorage.setItem(STORAGE_KEY, String(value)) } catch { /* 存储不可用时仍保留本次窗口的选择。 */ }
  }, [])
  const play = useCallback(() => {
    if (!enabledRef.current) return Promise.resolve()
    tone.current ??= new CompletionTone()
    return tone.current.play()
  }, [])
  return { enabled, setEnabled, play }
}
