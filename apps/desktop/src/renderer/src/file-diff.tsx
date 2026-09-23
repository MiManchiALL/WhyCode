import type { CheckpointFilePreview } from '@whycode/core'
import { useMemo } from 'react'
import { buildFileDiffHunks, previewTextState } from './file-change-presentation.ts'
import { FilePreviewMessage } from './file-preview-controls.tsx'
import { SyntaxCode } from './syntax-code.tsx'
import { useScrollArea } from './use-scroll-area.ts'

export function FileDiff({ path, preview, wrap = false, className = '' }: {
  path: string; preview: CheckpointFilePreview; wrap?: boolean; className?: string
}) {
  const before = preview.before.kind === 'missing' ? { ok: true as const, content: '' } : previewTextState(preview.before)
  const after = preview.after.kind === 'missing' ? { ok: true as const, content: '' } : previewTextState(preview.after)
  const beforeContent = before.ok ? before.content : null
  const afterContent = after.ok ? after.content : null
  const hunks = useMemo(() => beforeContent !== null && afterContent !== null
    ? buildFileDiffHunks(beforeContent, afterContent) : [], [beforeContent, afterContent])
  const { ref, onScroll, overscrollBehaviorY } = useScrollArea(hunks, { enabled: hunks.length > 0 })
  if (!before.ok) return <FilePreviewMessage>{before.message}</FilePreviewMessage>
  if (!after.ok) return <FilePreviewMessage>{after.message}</FilePreviewMessage>
  if (!hunks.length) return <FilePreviewMessage>{
    preview.before.kind === 'missing' ? '新建空文件' : preview.after.kind === 'missing' ? '已删除空文件'
      : beforeContent === afterContent ? '文件内容没有变化' : '改动较大，暂时无法生成文本差异'
  }</FilePreviewMessage>
  return <div ref={ref} onScroll={onScroll} style={{ overscrollBehaviorY }} className={`wc-scrollbar overflow-auto ${className}`}>
    {hunks.map((hunk, index) => <div key={hunk.id}>
      {index > 0 && <div className="wc-diff-hunk-gap" aria-label="另一处改动">···</div>}
      <SyntaxCode path={path} lines={hunk.lines} scroll={false} wrap={wrap} />
    </div>)}
  </div>
}
