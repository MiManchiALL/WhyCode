import { useEffect, useRef, useState } from 'react'

/** 快速请求也保留一圈旋转；请求本身的状态仍由各资源拥有者维护。 */
export function useRefreshFeedback(loading = false) {
  const [animating, setAnimating] = useState(false)
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; finish: () => void } | null>(null)
  useEffect(() => () => {
    if (!pending.current) return
    clearTimeout(pending.current.timer)
    pending.current.finish()
    pending.current = null
  }, [])

  const run = async (refresh: () => void | Promise<unknown>) => {
    if (loading || pending.current) return
    setAnimating(true)
    const animation = new Promise<void>(finish => {
      pending.current = { timer: setTimeout(finish, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 1000), finish }
    })
    const current = pending.current
    try {
      await refresh()
    } finally {
      await animation
      if (pending.current === current) {
        pending.current = null
        setAnimating(false)
      }
    }
  }
  return { busy: loading || animating, run }
}
