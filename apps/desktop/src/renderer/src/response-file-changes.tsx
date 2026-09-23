import { ChevronDown, ChevronUp, FileDiff, Undo2 } from 'lucide-react'
import { useState } from 'react'
import type { Block } from '../../shared/conversation-state.ts'
import type { RightPanelPage } from './right-panel-state.ts'
import { ChangeCounts, ChangedFilePath } from './file-change-summary.tsx'
import { useResponseFileChanges, totalFileChanges } from './response-file-changes-data.ts'

export function ResponseFileChanges({ runtimeId, projectDir, activity, onOpenChanges, onRevealRestore }: {
  runtimeId: string; projectDir: string | null; activity: readonly Block[]
  onOpenChanges?: (page: Extract<RightPanelPage, { kind: 'changes' }>) => void
  onRevealRestore?: () => void
}) {
  const checkpointIds = activity.flatMap(block => block.kind === 'tool' && block.call.checkpointId ? [block.call.checkpointId] : [])
  const state = useResponseFileChanges(runtimeId, checkpointIds)
  const [expanded, setExpanded] = useState(false)
  if (state.status === 'error') return <p role="status" className="py-2 text-xs text-[var(--wc-muted)]">{state.message}</p>
  if (state.status !== 'ready') return null
  const { changes } = state
  if (!changes.length) return null
  const open = (path: string | null) => onOpenChanges?.({
    kind: 'changes', checkpointIds, expandedPaths: path ? [path] : [], selectedPath: path,
  })
  return <section className="wc-response-changes" aria-label="本次文件改动">
    <div className="wc-change-header">
      <button type="button" className="wc-change-heading wc-focus-ring" title="查看本次文件改动"
        disabled={!onOpenChanges} onClick={() => open(null)}>
        <span className="wc-present-icon"><FileDiff size={20} aria-hidden="true" /></span>
        <span className="min-w-0">
          <span className="block font-medium">已更改 {changes.length} 个文件</span>
          <ChangeCounts {...totalFileChanges(changes)} />
        </span>
      </button>
      {onRevealRestore && <button type="button" className="wc-change-undo wc-focus-ring"
        title="定位到本轮回滚" aria-label="定位到本轮回滚" onClick={onRevealRestore}>
        撤销 <Undo2 size={14} aria-hidden="true" />
      </button>}
    </div>
    <ul className="wc-change-list">
      {(expanded ? changes : changes.slice(0, 3)).map(change => <li key={change.path}>
        <button type="button" className="wc-change-row wc-focus-ring" disabled={!onOpenChanges}
          aria-label={`查看 ${change.path} 的改动`} onClick={() => open(change.path)}>
          <ChangedFilePath path={change.path} projectDir={projectDir} />
          <ChangeCounts added={change.added} removed={change.removed} />
        </button>
      </li>)}
    </ul>
    {changes.length > 3 && <button type="button" className="wc-focus-ring wc-change-toggle"
      aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? '收起文件' : `再显示 ${changes.length - 3} 个文件`}
      {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
    </button>}
  </section>
}
