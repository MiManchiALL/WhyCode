import { useCallback, useRef, useState } from 'react'
import type { PdfAttachment } from '@whycode/core'
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

export function PdfPickerButton({
  disabled,
  onFiles,
}: {
  disabled: boolean
  onFiles: (files: FileList | null) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        disabled={disabled}
        className="hidden"
        onChange={(event) => {
          onFiles(event.currentTarget.files)
          event.currentTarget.value = ''
        }}
      />
      <button
        type="button"
        className="rounded-md border border-neutral-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        title={`添加或拖放 PDF（最多 ${MAX_PDF_DRAFTS} 个，单个 50 MB）`}
        aria-label="添加 PDF"
      >
        PDF
      </button>
    </>
  )
}

export function PdfDraftStrip({
  drafts,
  onRemove,
}: {
  drafts: readonly PdfDraft[]
  onRemove: (id: string) => void
}) {
  if (drafts.length === 0) return null
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {drafts.map((draft) => (
        <div
          key={draft.id}
          className="flex max-w-72 items-center gap-2 rounded border border-red-200 bg-white px-2 py-1.5 text-xs"
          title={`${draft.name} · ${formatBytes(draft.byteLength)}`}
        >
          <span className="rounded bg-red-600 px-1.5 py-1 font-semibold text-white">PDF</span>
          <span className="min-w-0 flex-1 truncate">{draft.name}</span>
          <span className="shrink-0 text-neutral-400">{formatBytes(draft.byteLength)}</span>
          <button
            type="button"
            className="shrink-0 text-neutral-400 hover:text-neutral-800"
            onClick={() => onRemove(draft.id)}
            title={`移除 ${draft.name}`}
            aria-label={`移除 ${draft.name}`}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

export function UserPdfGallery({ attachments }: { attachments?: readonly PdfAttachment[] }) {
  const [error, setError] = useState<string | null>(null)
  if (!attachments?.length) return null
  return (
    <div className="mb-2">
      <div className="flex flex-wrap gap-2">
        {attachments.map((attachment) => (
          <button
            key={attachment.id}
            type="button"
            className="flex max-w-sm items-center gap-2 rounded border border-red-200 bg-white px-3 py-2 text-left text-xs hover:border-red-400"
            title={`用系统默认阅读器打开 ${attachment.name}`}
            onClick={() => {
              setError(null)
              void window.whycode.openPdfAttachment(attachment.id).then((result) => {
                if (!result.ok) setError(result.error ?? '无法打开 PDF')
              }).catch(() => setError('无法打开 PDF'))
            }}
          >
            <span className="rounded bg-red-600 px-1.5 py-1 font-semibold text-white">PDF</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{attachment.name}</span>
              <span className="text-neutral-400">
                {attachment.pageCount} 页 · {formatBytes(attachment.byteLength)}
              </span>
            </span>
          </button>
        ))}
      </div>
      {error && <div className="mt-1 text-xs text-red-600">{error}</div>}
    </div>
  )
}

export function QueuedPdfStrip({ attachments }: { attachments?: readonly PdfAttachment[] }) {
  if (!attachments?.length) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {attachments.map((attachment) => (
        <span
          key={attachment.id}
          className="max-w-56 truncate rounded border border-red-200 bg-white px-1.5 py-1 text-[10px] text-red-700"
          title={attachment.name}
        >
          PDF · {attachment.name}
        </span>
      ))}
    </div>
  )
}

interface AppendPdfDraftResult {
  drafts: PdfDraft[]
  errors: string[]
}

function appendPdfDrafts(current: readonly PdfDraft[], files: readonly File[]): AppendPdfDraftResult {
  const drafts = [...current]
  const errors: string[] = []
  const knownPaths = new Set(current.flatMap((draft) =>
    draft.kind === 'path' ? [normalizePath(draft.path)] : []))
  let totalBytes = current.reduce((total, draft) => total + draft.byteLength, 0)

  for (const file of files) {
    if (!isPdf(file)) {
      errors.push(`${file.name || '未命名文件'} 不是 PDF`)
      continue
    }
    const path = getLocalPath(file)
    const normalizedPath = normalizePath(path)
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

function getLocalPath(file: File): string {
  try {
    return window.whycode.getPathForFile(file)
  } catch {
    return ''
  }
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

function isPdf(file: File): boolean {
  return file.type.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(file.name)
}

function formatBytes(bytes: number): string {
  return bytes < 1_000_000
    ? `${(bytes / 1_000).toFixed(1)} KB`
    : `${(bytes / 1_000_000).toFixed(2)} MB`
}
