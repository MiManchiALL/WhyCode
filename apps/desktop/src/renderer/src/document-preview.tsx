import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { FolderOpen, RefreshCw } from 'lucide-react'
import type { WorkspaceDocument } from '../../shared/workspace-files.ts'
import { MAX_TEXT_PREVIEW_BYTES } from '../../shared/workspace-files.ts'
import type { RightPanelPage } from './right-panel-state.ts'
import { FilePreviewMessage, FilePreviewToolbar, FileWrapButton } from './file-preview-controls.tsx'
import { useWorkspaceFile } from './use-workspace-file.ts'
import { SyntaxCode } from './syntax-code.tsx'
import { contentLines } from './file-change-presentation.ts'
import { MarkdownContent } from './markdown-content.tsx'

const PdfPreview = lazy(() => import('./pdf-preview.tsx'))
type FilePage = Extract<RightPanelPage, { kind: 'file' }>
interface DocumentProps {
  runtimeId: string
  page: FilePage
  onChange: (page: FilePage) => void
}

export function DocumentPreview({ runtimeId, page, onChange }: DocumentProps) {
  const file = useWorkspaceFile(runtimeId, 'file', page.path)
  const document = file.view?.kind === 'file' ? file.view : null
  const hasModes = document && document.size <= MAX_TEXT_PREVIEW_BYTES
    && (document.format === 'html' || document.format === 'markdown' || document.mediaType === 'image/svg+xml')
  const code = document?.format === 'code' || Boolean(hasModes && page.previewMode === 'code')
  const wrap = page.wrap ?? false
  const changeMode = async (previewMode: 'preview' | 'code') => {
    if (previewMode === (code ? 'code' : 'preview')) return
    if (await file.refresh()) onChange({ ...page, previewMode })
  }
  return <div className="flex min-h-0 flex-1 flex-col">
    <FilePreviewToolbar path={document?.path ?? page.path}>
      {hasModes && (
        <div className="flex shrink-0 rounded-md bg-black/[0.035] p-0.5" aria-label="文件显示方式">
          <button type="button" className="wc-preview-mode" aria-pressed={!code} disabled={file.loading}
            onClick={() => void changeMode('preview')}>预览</button>
          <button type="button" className="wc-preview-mode" aria-pressed={code} disabled={file.loading}
            onClick={() => void changeMode('code')}>代码</button>
        </div>
      )}
      {code && <FileWrapButton wrap={wrap} onChange={wrap => onChange({ ...page, wrap })} />}
      <button type="button" className="wc-preview-action" disabled={file.loading}
        title={file.changed ? '文件已更新，点击刷新' : '刷新文件'} aria-label="刷新文件"
        onClick={() => void file.refresh()}>
        <RefreshCw size={15} className={file.changed ? 'text-[var(--wc-sage-ink)]' : ''} />
        {file.changed && <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-[var(--wc-sage-ink)]" />}
      </button>
      <button type="button" className="wc-preview-action" disabled={!document}
        title="在文件夹中显示" aria-label="在文件夹中显示" onClick={file.reveal}>
        <FolderOpen size={15} />
      </button>
    </FilePreviewToolbar>
    {file.error ? <FilePreviewMessage>{file.error}</FilePreviewMessage> : document ? (
      <DocumentBody document={document} code={code} wrap={wrap} onOpenExternally={file.openExternally} />
    ) : <FilePreviewMessage>正在读取文件…</FilePreviewMessage>}
  </div>
}

function DocumentBody({ document, code, wrap, onOpenExternally }: {
  document: WorkspaceDocument; code: boolean; wrap: boolean; onOpenExternally: () => void
}) {
  if (!document.url) return <FilePreviewMessage>
    <div>
      <p>此文件暂不支持内嵌预览</p>
      <button type="button" className="wc-focus-ring mt-3 rounded-lg border border-[var(--wc-line)] px-3 py-1.5 text-[var(--wc-ink)]"
        onClick={onOpenExternally}>用默认应用打开</button>
    </div>
  </FilePreviewMessage>
  if (code || document.format === 'markdown') return <TextDocument key={document.url} url={document.url} path={document.path} markdown={!code} wrap={wrap} />
  if (document.format === 'html') return (
    <iframe key={document.url} src={document.url} sandbox="allow-scripts" title={document.name}
      className="min-h-0 w-full flex-1 border-0 bg-white" data-html-preview />
  )
  if (document.format === 'image') return <ImageDocument key={document.url} url={document.url} name={document.name} />
  if (document.format === 'pdf') return (
    <Suspense fallback={<FilePreviewMessage>正在准备 PDF 阅读器…</FilePreviewMessage>}>
      <PdfPreview url={document.url} size={document.size} />
    </Suspense>
  )
  return null
}

function TextDocument({ url, path, markdown, wrap }: { url: string; path: string; markdown: boolean; wrap: boolean }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    setError(null)
    void fetch(url, { signal: abort.signal }).then(async response => {
      if (!response.ok) throw new Error('文件已移动或无法读取，请刷新后重试')
      if (Number(response.headers.get('Content-Length')) > MAX_TEXT_PREVIEW_BYTES) {
        await response.body?.cancel()
        throw new Error('文件超过 2 MiB，无法显示代码，请在文件夹中打开')
      }
      const content = await response.text()
      if (!abort.signal.aborted) setText(content)
    }).catch(error => {
      if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error))
    })
    return () => abort.abort()
  }, [url])
  const lines = useMemo(() => markdown || text === null ? [] : contentLines(text), [markdown, text])
  if (error) return <FilePreviewMessage>{error}</FilePreviewMessage>
  if (text === null) return <FilePreviewMessage>正在读取正文…</FilePreviewMessage>
  if (markdown) return (
    <div className="wc-scrollbar min-h-0 flex-1 overflow-auto p-4"><MarkdownContent text={text} /></div>
  )
  return <SyntaxCode path={path} lines={lines} wrap={wrap} className="flex-1" />
}

function ImageDocument({ url, name }: { url: string; name: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <FilePreviewMessage>图片无法解码，请刷新文件后重试</FilePreviewMessage>
  return (
    <div className="wc-scrollbar flex min-h-0 flex-1 overflow-auto bg-black/[0.02] p-3">
      <img src={url} alt={name} onError={() => setFailed(true)} className="m-auto h-auto max-w-full shrink-0 object-contain" />
    </div>
  )
}
