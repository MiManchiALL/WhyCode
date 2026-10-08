import { filePathKey, localFilePath } from './local-files.ts'
import { useCallback, useRef, useState } from 'react'
import type { PdfAttachment } from '@whycode/core'
import { FileText, X } from 'lucide-react'
import {
  MAX_PDF_DRAFT_BYTES,
  MAX_PDF_DRAFT_TOTAL_BYTES,
  MAX_PDF_DRAFTS,
  type PdfDraft,
} from './pdf-draft.ts'

export function usePdfDrafts(onError: (message: string) => void) {
  const [drafts, setDrafts] = useState<PdfDraft[]>([])
  const draftsRef = useRef<PdfDraft[]>([])
  const replace = useCallback((next: PdfDraft[]) => {
    draftsRef.current = next
    setDrafts(next)
  }, [])
  const clear = useCallback(() => replace([]), [replace])
  const remove = useCallback((id: string) => {
    replace(draftsRef.current.filter((draft) => draft.id !== id))
  }, [replace])
  const detach = useCallback(() => {
    const detached = draftsRef.current
    replace([])
    return detached
  }, [replace])
  const restore = useCallback((rejected: readonly PdfDraft[]) => {
    const known = new Set(draftsRef.current.map((draft) => draft.id))
    const candidates = rejected.filter((draft) => !known.has(draft.id))
    replace([...candidates, ...draftsRef.current].slice(0, MAX_PDF_DRAFTS))
  }, [replace])
  const addFiles = useCallback((files: FileList | readonly File[] | null) => {
    if (!files?.length) return
    const result = appendPdfDrafts(draftsRef.current, Array.from(files))
    replace(result.drafts)
    if (result.errors.length > 0) onError(`部分 PDF 未添加（${result.errors.join('；')}）`)
  }, [onError, replace])
  return { drafts, addFiles, remove, clear, detach, restore }
}

export function PdfDraftStrip({
  drafts,
  onRemove,
  className = 'mb-2',
}: {
  drafts: readonly PdfDraft[]
  onRemove?: (id: string) => void
  className?: string
}) {
  if (drafts.length === 0) return null
  return (
    <div className={`flex max-w-full flex-wrap gap-2 ${className}`}>
      {drafts.map((draft) => (
        <PdfChip key={draft.id} name={draft.name} byteLength={draft.byteLength}
          onRemove={onRemove ? () => onRemove(draft.id) : undefined} />
      ))}
    </div>
  )
}

export function UserPdfGallery({
  runtimeId,
  attachments,
}: {
  runtimeId: string
  attachments?: readonly PdfAttachment[]
}) {
  const [error, setError] = useState<string | null>(null)
  if (!attachments?.length) return null
  return (
    <div className="max-w-full">
      <div className="flex flex-wrap justify-end gap-2">
        {attachments.map((attachment) => (
          <PdfChip key={attachment.id} name={attachment.name} byteLength={attachment.byteLength} pageCount={attachment.pageCount}
            onOpen={() => {
              setError(null)
              void window.whycode.openPdfAttachment(runtimeId, attachment.id).then((result) => {
                if (!result.ok) setError(result.error ?? '无法打开 PDF')
              }).catch(() => setError('无法打开 PDF'))
            }}
          />
        ))}
      </div>
      {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
    </div>
  )
}

export function QueuedPdfStrip({ attachments }: { attachments?: readonly PdfAttachment[] }) {
  if (!attachments?.length) return null
  return (
    <div className="mt-1 flex max-w-full flex-wrap gap-2">
      {attachments.map((attachment) => (
        <PdfChip key={attachment.id} name={attachment.name} byteLength={attachment.byteLength} pageCount={attachment.pageCount} />
      ))}
    </div>
  )
}

function PdfChip({ name, byteLength, pageCount, onOpen, onRemove }: {
  name: string
  byteLength: number
  pageCount?: number
  onOpen?: () => void
  onRemove?: () => void
}) {
  const Tag = onOpen ? 'button' : 'div'
  const title = [name, pageCount ? `${pageCount} 页` : '', formatBytes(byteLength), onOpen ? '点击打开' : ''].filter(Boolean).join(' · ')
  return <Tag
    type={onOpen ? 'button' : undefined}
    onClick={onOpen}
    title={title}
    className={`wc-user-message-copy wc-focus-ring flex min-w-0 max-w-[min(100%,24rem)] items-center gap-2 rounded-full border border-[var(--wc-line)] bg-white px-3 py-2 text-left shadow-[1px_2px_0_rgb(43_46_41_/_4%)] ${onOpen ? 'transition-colors hover:border-[var(--wc-line-strong)]' : ''}`}
  >
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[#d85858] text-white" aria-hidden="true">
      <FileText size={11} />
    </span>
    <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
    {onRemove && <button type="button" className="wc-focus-ring flex size-5 shrink-0 items-center justify-center rounded-full text-[var(--wc-muted)] transition-colors hover:bg-black/5 hover:text-[var(--wc-ink)]"
      onClick={onRemove} title={`移除 ${name}`} aria-label={`移除 ${name}`}><X size={12} /></button>}
  </Tag>
}

interface AppendPdfDraftResult {
  drafts: PdfDraft[]
  errors: string[]
}

function appendPdfDrafts(current: readonly PdfDraft[], files: readonly File[]): AppendPdfDraftResult {
  const drafts = [...current]
  const errors: string[] = []
  const knownPaths = new Set(current.flatMap((draft) =>
    draft.kind === 'path' ? [filePathKey(draft.path)] : []))
  let totalBytes = current.reduce((total, draft) => total + draft.byteLength, 0)

  for (const file of files) {
    if (!isPdf(file)) {
      errors.push(`${file.name || '未命名文件'} 不是 PDF`)
      continue
    }
    const path = localFilePath(file)
    const normalizedPath = filePathKey(path)
    if (!path) {
      errors.push(`${file.name || 'PDF'} 没有可读取的本地路径`)
      continue
    }
    if (drafts.length >= MAX_PDF_DRAFTS || knownPaths.has(normalizedPath)) {
      errors.push(`${file.name} 重复或超过 ${MAX_PDF_DRAFTS} 个`)
      continue
    }
    if (file.size <= 0 || file.size > MAX_PDF_DRAFT_BYTES) {
      errors.push(`${file.name} 为空或超过 50 MB`)
      continue
    }
    if (totalBytes + file.size > MAX_PDF_DRAFT_TOTAL_BYTES) {
      errors.push(`${file.name} 会使总大小超过 100 MB`)
      continue
    }
    knownPaths.add(normalizedPath)
    totalBytes += file.size
    drafts.push({
      kind: 'path',
      id: normalizedPath,
      name: file.name || 'document.pdf',
      byteLength: file.size,
      path,
    })
  }
  return { drafts, errors }
}

function isPdf(file: File): boolean {
  return file.type.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(file.name)
}

function formatBytes(bytes: number): string {
  return bytes < 1_000_000
    ? `${(bytes / 1_000).toFixed(1)} KB`
    : `${(bytes / 1_000_000).toFixed(2)} MB`
}
