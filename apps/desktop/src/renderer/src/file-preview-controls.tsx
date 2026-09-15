import { WrapText } from 'lucide-react'
import type { ReactNode } from 'react'

export function FilePreviewToolbar({ path, children }: { path: string; children: ReactNode }) {
  return (
    <div className="wc-file-preview-toolbar flex min-w-0 shrink-0 items-center gap-1 border-b border-[var(--wc-line)] px-3 py-2 text-xs">
      <div className="min-w-0 flex-1 truncate font-mono text-[var(--wc-faint)]" title={path}>{path}</div>
      {children}
    </div>
  )
}

export function FileWrapButton({ wrap, onChange }: { wrap: boolean; onChange: (wrap: boolean) => void }) {
  return (
    <button type="button" className="wc-preview-action" aria-pressed={wrap}
      title={wrap ? '关闭自动换行' : '开启自动换行'} aria-label="自动换行"
      onClick={() => onChange(!wrap)}>
      <WrapText size={15} />
    </button>
  )
}

export function FilePreviewMessage({ children }: { children: ReactNode }) {
  return <div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-4 py-8 text-center text-xs text-[var(--wc-faint)]">{children}</div>
}
