import type { ToolFileChange } from '@whycode/core/events'
import type { PresentedFile } from '@whycode/core/presentation'
import { ChevronDown, ChevronUp, FileDiff } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Block } from '../../shared/conversation-state.ts'
import { displayFilePath, fileName, filePathKey } from './local-files.ts'

export function ResponseFileChanges({ runtimeId, projectDir, activity, files }: {
  runtimeId: string; projectDir: string | null; activity: readonly Block[]; files: readonly PresentedFile[]
}) {
  const checkpoints = activity.flatMap(block => block.kind === 'tool' && block.call.checkpointId
    ? [block.call.checkpointId] : []).join(',')
  const [changes, setChanges] = useState<ToolFileChange[]>([])
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    let active = true
    setChanges([])
    setError(null)
    if (checkpoints) void window.whycode.checkpointFileChanges({ runtimeId, checkpointIds: checkpoints.split(',') }).then(result => {
      if (!active) return
      if (result.ok) setChanges(result.changes)
      else setError(result.error)
    }).catch(error => {
      if (active) setError(error instanceof Error ? error.message : String(error))
    })
    return () => { active = false }
  }, [runtimeId, checkpoints])
  const presented = new Set(files.map(file => filePathKey(file.path)))
  const remaining = changes.filter(change => !presented.has(filePathKey(change.path)))
  if (error) return <p role="status" className="wc-type-caption py-2 text-[var(--wc-muted)]">{error}</p>
  if (!remaining.length) return null
  const totals = remaining.reduce((sum, change) => ({ added: sum.added + change.added, removed: sum.removed + change.removed }), { added: 0, removed: 0 })
  return <section className="wc-response-changes" aria-label="本次文件改动">
    <div className="wc-change-heading">
      <span className="wc-present-icon"><FileDiff size={20} aria-hidden="true" /></span>
      <div className="min-w-0">
        <p className="wc-type-control font-medium">已更改 {remaining.length} 个文件</p>
        <ChangeCounts {...totals} />
      </div>
    </div>
    <ul className="wc-change-list">
      {(expanded ? remaining : remaining.slice(0, 3)).map(change => {
        const path = displayFilePath(change.path, projectDir)
        const name = fileName(path)
        return <li key={change.path} className="wc-change-row wc-type-control">
          <span className="wc-change-path" title={change.path}>
            <span className="min-w-0 truncate text-[var(--wc-muted)]">{path.slice(0, -name.length)}</span>
            <span className="max-w-full shrink-0 truncate">{name}</span>
          </span>
          <ChangeCounts added={change.added} removed={change.removed} />
        </li>
      })}
    </ul>
    {remaining.length > 3 && <button type="button" className="wc-focus-ring wc-change-toggle wc-type-control"
      aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? '收起文件' : `再显示 ${remaining.length - 3} 个文件`}
      {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
    </button>}
  </section>
}

function ChangeCounts({ added, removed }: { added: number; removed: number }) {
  return <span className="wc-type-caption flex shrink-0 gap-1.5 tabular-nums">
    <span className="wc-tool-lines-added">+{added}</span>
    <span className="wc-tool-lines-removed">-{removed}</span>
  </span>
}
