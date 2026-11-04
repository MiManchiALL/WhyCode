import { useEffect, useState } from 'react'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { LoaderCircle } from 'lucide-react'
import { DIAGNOSTIC_LIMITS, type DiagnosticState } from '../../shared/diagnostics.ts'
import { SettingsButton, SettingsPanel, SettingsRow, SettingsSection } from './settings-layout.tsx'
import { useConversationFeedback } from './conversation-feedback.tsx'

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`

export function DiagnosticSettings() {
  const [state, setState] = useState<DiagnosticState | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const feedback = useConversationFeedback()
  useEffect(() => {
    let active = true
    let notified = false
    const unsubscribe = window.whycode.onDiagnosticsChanged(value => {
      notified = true
      if (active) setState(value)
    })
    void window.whycode.getDiagnosticState().then(value => {
      if (active && !notified) setState(value)
    }, error => { if (active) feedback('error', String(error), true) })
    return () => { active = false; unsubscribe() }
  }, [feedback])
  const busy = submitting || !state || state.busy !== null
  const run = async (action: 'open' | 'export' | 'clear') => {
    if (busy) return
    setConfirm(false); setSubmitting(true)
    try {
      if (action === 'open') await window.whycode.openDiagnosticDirectory()
      if (action === 'export' && await window.whycode.exportDiagnostics()) feedback('success', '诊断日志已导出', true)
      if (action === 'clear') {
        await window.whycode.clearDiagnostics()
        feedback('success', '已清除诊断日志，新事件将继续记录', true)
      }
    } catch (error) { feedback('error', String(error), true) }
    finally { setSubmitting(false) }
  }

  return <AlertDialog.Root open={confirm} onOpenChange={setConfirm}>
    <SettingsSection title="诊断日志" description="在本机保存运行记录和故障现场，达到容量上限后自动淘汰旧记录。">
      <SettingsPanel padded={false}>
        <SettingsRow label="运行日志" description={`最多 ${DIAGNOSTIC_LIMITS.retentionDays} 天，总容量 ${mib(DIAGNOSTIC_LIMITS.runtimeFiles * DIAGNOSTIC_LIMITS.runtimeFileBytes)}。记录较多时，保留时间会缩短。`} divided={false}>
          <span className="text-sm text-[var(--wc-muted)]">{state ? `已用 ${mib(state.runtimeBytes)}` : '正在读取…'}</span>
        </SettingsRow>
        <SettingsRow label="故障报告" description={`保留最近 ${DIAGNOSTIC_LIMITS.reports} 份，每份最多 ${mib(DIAGNOSTIC_LIMITS.reportBytes)}。`}>
          <span className="text-sm text-[var(--wc-muted)]">{state ? `${state.reportCount} 份 · ${mib(state.reportBytes)}` : '正在读取…'}</span>
        </SettingsRow>
        <SettingsRow label="查看与导出" description="诊断包保存到你选择的位置，可用于排查问题。">
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <SettingsButton disabled={busy} onClick={() => void run('open')}>打开文件夹</SettingsButton>
            <SettingsButton disabled={busy} onClick={() => void run('export')}>导出诊断包</SettingsButton>
          </div>
        </SettingsRow>
        <SettingsRow label="清除诊断日志" description="删除已有运行日志和故障报告，随后继续记录新事件。">
          <div className="flex sm:justify-end"><AlertDialog.Trigger asChild><SettingsButton variant="danger" disabled={busy}>清除日志</SettingsButton></AlertDialog.Trigger></div>
        </SettingsRow>
      </SettingsPanel>
      {state?.busy && <p role="status" className="flex items-center gap-2 text-[13px] text-[var(--wc-muted)]"><LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
        {state.busy === 'clearing' ? '正在清理…' : '正在导出…'}可以离开设置，操作会继续。
      </p>}
      {state?.error && <p role="alert" className="text-sm text-[var(--wc-muted)]">日志记录不完整：{state.error}。可清除日志后重试。</p>}
      {!!state?.droppedRecords && <p className="text-sm text-[var(--wc-muted)]">有 {state.droppedRecords} 条记录因写入积压或失败未保存。</p>}
    </SettingsSection>
    <AlertDialog.Portal>
      <AlertDialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
      <AlertDialog.Content className="wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[91] max-h-[90vh] w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5 outline-none">
        <AlertDialog.Title className="text-base font-semibold">清除诊断日志？</AlertDialog.Title>
        <AlertDialog.Description className="mt-3 text-sm leading-6 text-[var(--wc-muted)]">删除当前保存的运行日志和故障报告，此操作无法撤销。会话记录、工作区文件、浏览器数据及已导出的诊断包保留。</AlertDialog.Description>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <AlertDialog.Cancel asChild><SettingsButton>取消</SettingsButton></AlertDialog.Cancel>
          <AlertDialog.Action asChild><SettingsButton variant="danger" disabled={busy} onClick={() => void run('clear')}>清除日志</SettingsButton></AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>
}
