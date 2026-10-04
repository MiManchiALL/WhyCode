import type { BrowserDataState } from '../../shared/browser.ts'

/** 先订阅再取快照；界面重开能恢复进度，迟到快照不能覆盖清理通知。 */
export function watchBrowserData(onChange: (state: BrowserDataState) => void, onError: (error: unknown) => void): () => void {
  let active = true
  let notified = false
  const unsubscribe = window.whycode.onBrowserDataChanged(state => {
    notified = true
    if (active) onChange(state)
  })
  void window.whycode.getBrowserDataState().then(state => {
    if (active && !notified) onChange(state)
  }, error => { if (active && !notified) onError(error) })
  return () => { active = false; unsubscribe() }
}
