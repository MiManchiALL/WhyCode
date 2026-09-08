import type { FileChangeSummary } from './file-change-presentation.ts'
import { useEffect, useState } from 'react'

export function ComposerFileChanges({
  changes,
}: {
  changes: readonly FileChangeSummary[]
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (changes.length === 0) setOpen(false)
  }, [changes.length])
  if (changes.length === 0) return null
  const totals = changes.reduce(
    (result, change) => ({
      added: result.added + change.added,
      removed: result.removed + change.removed,
    }),
    { added: 0, removed: 0 },
  )
  return (
    <div
      className="wc-composer-file-changes relative z-20 min-w-0 max-w-full justify-self-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <div
        className="wc-focus-ring flex min-w-0 items-center gap-1 rounded-xl border border-[var(--wc-line)] bg-[var(--wc-surface)] px-3 py-1 text-xs text-[var(--wc-muted)] shadow-sm"
        tabIndex={0}
        aria-label={`${changes.length} 个文件已更改`}
      >
        <span className="truncate">{changes.length} 个文件已更改</span>
        <span className="wc-tool-lines-added shrink-0 tabular-nums">+<LineCount value={totals.added} /></span>
        <span className="wc-tool-lines-removed shrink-0 tabular-nums">-<LineCount value={totals.removed} /></span>
      </div>
      {open ? (
        <div className="absolute bottom-full left-1/2 w-[min(20rem,calc(100vw-3rem))] -translate-x-1/2 pb-0.5">
          <div className="wc-composer-file-popover wc-scrollbar max-h-72 overflow-y-auto rounded-2xl border border-[var(--wc-line)] bg-[var(--wc-surface)] p-1 shadow-xl">
            {changes.map((change) => (
              <div
                key={change.path}
                className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-1.5 text-xs"
                title={change.path}
              >
                <span className="min-w-0 flex-1 truncate text-[var(--wc-muted)]">{change.name}</span>
                <span className="flex shrink-0 gap-1.5 tabular-nums">
                  <span className="wc-tool-lines-added">+<LineCount value={change.added} /></span>
                  <span className="wc-tool-lines-removed">-<LineCount value={change.removed} /></span>
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function LineCount({ value }: { value: number }) {
  const digits = String(value)
  return (
    <span className="inline-flex align-baseline">
      <span className="sr-only">{digits}</span>
      <span aria-hidden="true" className="inline-flex">
        {Array.from(digits, (digit, index) => (
          <span key={digits.length - index} className="relative inline-block h-[1em] w-[1ch] overflow-hidden">
            <span
              className="flex flex-col transition-transform duration-300 ease-out motion-reduce:transition-none"
              style={{ transform: `translateY(${Number(digit) - 9}em)` }}
            >
              {[9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((number) => (
                <span key={number} className="h-[1em] leading-none">{number}</span>
              ))}
            </span>
          </span>
        ))}
      </span>
    </span>
  )
}
