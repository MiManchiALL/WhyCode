import { useEffect, useState } from 'react'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { LoaderCircle } from 'lucide-react'
import type { BrowserDataClearMode, BrowserDataState } from '../../shared/browser.ts'
import { watchBrowserData } from './browser-data-state.ts'
import { useConversationFeedback } from './conversation-feedback.tsx'
import { SettingsButton, SettingsPanel, SettingsRow, SettingsSection } from './settings-layout.tsx'

export function BrowserDataSettings() {
  const [state, setState] = useState<BrowserDataState | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const feedback = useConversationFeedback()
  useEffect(() => watchBrowserData(setState, error => feedback('error', String(error), true)), [feedback])
  const busy = submitting || !state || state.clearing !== null
  const clear = async (mode: BrowserDataClearMode) => {
    if (busy) return
    setConfirm(false)
    setSubmitting(true)
    try {
      await window.whycode.clearBrowserData(mode)
      feedback('success', mode === 'cache' ? '已清除浏览器缓存，登录状态已保留' : '已清除全部浏览器数据', true)
    } catch (error) { feedback('error', String(error), true) }
    finally { setSubmitting(false) }
  }

  return <AlertDialog.Root open={confirm} onOpenChange={setConfirm}><SettingsSection title="内置浏览器" description="所有会话共用浏览器登录与网站数据，可按需要清理。">
    <SettingsPanel padded={false}>
      <SettingsRow label="清除内置浏览器缓存" description="释放缓存空间，保留登录状态和网站本地数据。" divided={false}>
        <div className="flex sm:justify-end"><SettingsButton disabled={busy} onClick={() => void clear('cache')}>清除缓存</SettingsButton></div>
      </SettingsRow>
      <SettingsRow label="清除全部浏览器数据" description="关闭内置浏览器标签，清除登录、网站数据和缓存。">
        <div className="flex sm:justify-end"><AlertDialog.Trigger asChild><SettingsButton variant="danger" disabled={busy}>清除全部数据</SettingsButton></AlertDialog.Trigger></div>
      </SettingsRow>
    </SettingsPanel>
    {state?.clearing && <p role="status" className="flex items-center gap-2 text-[13px] text-[var(--wc-muted)]">
      <LoaderCircle size={14} aria-hidden="true" className="animate-spin" />
      {state.clearing === 'cache' ? '正在清除浏览器缓存…' : '正在清除全部浏览器数据…'}可以离开设置，清理会继续。
    </p>}
    <AlertDialog.Portal>
      <AlertDialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
      <AlertDialog.Content className="wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[91] max-h-[90vh] w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5 outline-none">
        <AlertDialog.Title className="text-base font-semibold">清除全部浏览器数据？</AlertDialog.Title>
        <AlertDialog.Description className="mt-3 text-sm leading-6 text-[var(--wc-muted)]">
          关闭所有会话中的内置浏览器标签，停止未完成的下载，并删除 Cookie、网站本地数据及缓存。所有网站将退出登录，此操作无法撤销。<br />
          会话记录、工作区文件和已保存的下载文件保留。
        </AlertDialog.Description>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <AlertDialog.Cancel asChild><SettingsButton>取消</SettingsButton></AlertDialog.Cancel>
          <AlertDialog.Action asChild><SettingsButton variant="danger" disabled={busy} onClick={() => void clear('all')}>清除全部数据</SettingsButton></AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </SettingsSection></AlertDialog.Root>
}
