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
      className="wc-composer-file-changes relative z-20 mb-2 flex justify-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <div
        className="wc-focus-ring rounded-xl border border-[var(--wc-line)] bg-[var(--wc-surface)] px-3 py-1 text-xs text-[var(--wc-muted)] shadow-sm"
        tabIndex={0}
        aria-label={`${changes.length} 个文件已更改`}
      >
        {changes.length} 个文件已更改{' '}
        <span className="wc-tool-lines-added tabular-nums">+{totals.added}</span>{' '}
        <span className="wc-tool-lines-removed tabular-nums">-{totals.removed}</span>
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
                  <span className="wc-tool-lines-added">+{change.added}</span>
                  <span className="wc-tool-lines-removed">-{change.removed}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
