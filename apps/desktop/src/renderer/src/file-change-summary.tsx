import { displayFilePath, fileName } from './local-files.ts'

export function ChangedFilePath({ path, projectDir }: { path: string; projectDir: string | null }) {
  const display = displayFilePath(path, projectDir)
  const name = fileName(display)
  return <span className="wc-change-path" title={path}>
    <span className="min-w-0 truncate text-[var(--wc-muted)]">{display.slice(0, -name.length)}</span>
    <span className="max-w-full shrink-0 truncate">{name}</span>
  </span>
}

export function ChangeCounts({ added, removed }: { added: number; removed: number }) {
  return <span className="wc-change-counts flex shrink-0 gap-1.5 text-xs tabular-nums">
    <span className="wc-tool-lines-added">+{added}</span>
    <span className="wc-tool-lines-removed">-{removed}</span>
  </span>
}
