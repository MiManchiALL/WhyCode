import { ChevronRight, Download, FolderOpen, PanelRightOpen } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import type { RightPanelPage } from './right-panel-state.ts'
import { ChangeCounts, ChangedFilePath } from './file-change-summary.tsx'
import { fileIcon } from './file-preview-controls.tsx'
import { fileName, filePathKey } from './local-files.ts'
import { useWorkspaceFileAction } from './use-workspace-file-action.ts'

export function ChangedFile({ runtimeId, projectDir, remote, onOpenPage, change, expanded, onToggle, children, label }: {
  runtimeId: string; projectDir: string | null; remote?: boolean; onOpenPage: (page: RightPanelPage) => void
  change: { path: string; added?: number; removed?: number }; expanded: boolean; onToggle: () => void
  children: ReactNode; label?: string
}) {
  const id = useId()
  const name = fileName(change.path)
  const Icon = fileIcon(name)
  const action = useWorkspaceFileAction(runtimeId, change.path)
  return <section className="wc-changes-file" data-expanded={expanded} data-change-path={filePathKey(change.path)}>
    <div className="wc-changes-file-heading">
      <button type="button" className="wc-changes-file-trigger wc-focus-ring" onClick={onToggle}
        title={label ? `${change.path}\n${label}` : change.path} aria-expanded={expanded} aria-controls={expanded ? id : undefined} aria-label={`查看 ${change.path} 的改动`}>
        <ChevronRight size={13} className="wc-changes-chevron shrink-0" aria-hidden="true" />
        <Icon size={14} className="shrink-0 text-[var(--wc-muted)]" aria-hidden="true" />
        <ChangedFilePath path={change.path} projectDir={projectDir} />
        {label && <span className="wc-git-file-label">{label}</span>}
        {change.added !== undefined && change.removed !== undefined && <ChangeCounts added={change.added} removed={change.removed} />}
      </button>
      <div className="wc-changes-file-actions">
        <button type="button" className="wc-preview-action" title="在标签页中打开文件" aria-label={`在标签页中打开 ${name}`}
          onClick={() => onOpenPage({ kind: 'file', path: change.path, name, source: { kind: 'current' }, previewMode: 'code' })}>
          <PanelRightOpen size={14} />
        </button>
        <button type="button" className="wc-preview-action" title={remote ? '保存到本机' : '在文件夹中显示'} aria-label={`${remote ? '保存到本机' : '在文件夹中显示'} ${name}`}
          disabled={action.pending} aria-busy={action.pending} onClick={() => void action.run(remote ? 'save' : 'reveal')}>
          {remote ? <Download size={14} /> : <FolderOpen size={14} />}
        </button>
      </div>
    </div>
    {expanded && <div id={id} className="wc-changes-file-diff">{children}</div>}
  </section>
}
