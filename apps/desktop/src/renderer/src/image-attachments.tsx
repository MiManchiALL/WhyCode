import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImageAttachment } from '@whycode/core'
import {
  MAX_IMAGE_DRAFT_BYTES,
  MAX_IMAGE_DRAFTS,
  type ImageDraft,
} from './image-draft.ts'
import { ImagePreviewDialog, type ImagePreviewTarget } from './image-preview.tsx'

const SUPPORTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp'])

export function useImageDrafts(onError: (message: string) => void) {
  const [drafts, setDrafts] = useState<ImageDraft[]>([])
  const draftsRef = useRef<ImageDraft[]>([])

  useEffect(() => () => releaseImageDrafts(draftsRef.current), [])

  const replace = useCallback((next: ImageDraft[]) => {
    draftsRef.current = next
    setDrafts(next)
  }, [])

  const clear = useCallback(() => {
    releaseImageDrafts(draftsRef.current)
    replace([])
  }, [replace])

  const addFiles = useCallback((files: FileList | readonly File[] | null) => {
    if (!files?.length) return
    const result = appendImageDrafts(draftsRef.current, Array.from(files))
    replace(result.drafts)
    const error = formatDraftError(result)
    if (error) onError(error)
  }, [onError, replace])

  const remove = useCallback((id: string) => {
    const next = draftsRef.current.filter((draft) => {
      if (draft.id !== id) return true
      releaseImageDraft(draft)
      return false
    })
    replace(next)
  }, [replace])

  const detach = useCallback((): ImageDraft[] => {
    const detached = draftsRef.current
    replace([])
    return detached
  }, [replace])

  const restore = useCallback((rejected: readonly ImageDraft[]) => {
    const current = draftsRef.current
    const known = new Set(current.map((draft) => draft.id))
    for (const duplicate of rejected.filter((draft) => known.has(draft.id))) {
      releaseImageDraft(duplicate)
    }
    const candidates = rejected.filter((draft) => !known.has(draft.id))
    const restored = candidates.slice(0, Math.max(0, MAX_IMAGE_DRAFTS - current.length))
    releaseImageDrafts(candidates.slice(restored.length))
    replace([...restored, ...current])
  }, [replace])

  return { drafts, addFiles, remove, clear, detach, restore }
}

export function ImageDraftStrip({
  drafts,
  onRemove,
}: {
  drafts: readonly ImageDraft[]
  onRemove: (id: string) => void
}) {
  const [preview, setPreview] = useState<ImagePreviewTarget | null>(null)
  if (drafts.length === 0) return null
  return (
    <>
      <div className="mb-2 flex flex-wrap gap-2">
        {drafts.map((draft) => (
          <div key={draft.id} className="group relative h-20 w-20 overflow-hidden rounded border border-neutral-200 bg-white">
            <button
              type="button"
              className="block h-full w-full cursor-zoom-in"
              onClick={() => setPreview({ src: draft.previewUrl, name: draft.name })}
              title={`查看 ${draft.name}`}
            >
              <img src={draft.previewUrl} alt={draft.name} className="h-full w-full object-cover" />
            </button>
            <button
              type="button"
              className="absolute right-1 top-1 rounded bg-black/65 px-1.5 py-0.5 text-xs text-white opacity-80 hover:opacity-100"
              onClick={() => onRemove(draft.id)}
              title={`移除 ${draft.name}`}
              aria-label={`移除 ${draft.name}`}
            >
              ×
            </button>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-[10px] text-white">
              {draft.name}
            </div>
          </div>
        ))}
      </div>
      <ImagePreviewDialog target={preview} onClose={() => setPreview(null)} />
    </>
  )
}

export function ImagePickerButton({
  supportsImageInput,
  disabled,
  onFiles,
}: {
  supportsImageInput: boolean
  disabled: boolean
  onFiles: (files: FileList | null) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const enabled = supportsImageInput && !disabled
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        disabled={!enabled}
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={(event) => {
          onFiles(event.currentTarget.files)
          event.currentTarget.value = ''
        }}
      />
      <button
        className="rounded-md border border-neutral-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => inputRef.current?.click()}
        disabled={!enabled}
        title={
          enabled
            ? `添加、拖放或在输入框按 Ctrl+V 粘贴图片（最多 ${MAX_IMAGE_DRAFTS} 张）`
            : supportsImageInput
              ? '图片正在发送或当前操作暂时锁定附件'
              : '当前模型不支持识图；请切换到带“图片”标记的模型'
        }
        aria-label="添加图片"
      >
        🖼
      </button>
    </>
  )
}

export function UserImageGallery({ attachments }: { attachments?: readonly ImageAttachment[] }) {
  const [preview, setPreview] = useState<ImagePreviewTarget | null>(null)
  if (!attachments?.length) return null
  return (
    <>
      <div className="mb-2 flex flex-wrap gap-2">
        {attachments.map((attachment) => {
          const src = `whycode-attachment://${attachment.sessionId}/${encodeURIComponent(attachment.storageName)}`
          const details = `${attachment.width}×${attachment.height} · ${formatBytes(attachment.byteLength)}`
          return (
            <button
              key={attachment.id}
              type="button"
              className="cursor-zoom-in rounded border border-neutral-300 bg-white p-0.5"
              onClick={() => setPreview({ src, name: attachment.name, details })}
              title={`${attachment.name} · ${details} · 点击查看原图`}
            >
              <img
                src={src}
                alt={attachment.name}
                loading="lazy"
                className="max-h-56 max-w-72 object-contain"
              />
            </button>
          )
        })}
      </div>
      <ImagePreviewDialog target={preview} onClose={() => setPreview(null)} />
    </>
  )
}

export function QueuedImageStrip({ attachments }: { attachments?: readonly ImageAttachment[] }) {
  if (!attachments?.length) return null
  return (
    <div className="mt-1 flex gap-1">
      {attachments.map((attachment) => (
        <img
          key={attachment.id}
          src={`whycode-attachment://${attachment.sessionId}/${encodeURIComponent(attachment.storageName)}`}
          alt={attachment.name}
          title={`${attachment.name} · ${attachment.width}×${attachment.height}`}
          className="h-10 w-10 rounded border border-neutral-200 bg-white object-cover"
        />
      ))}
    </div>
  )
}

export function releaseImageDrafts(drafts: readonly ImageDraft[]): void {
  for (const draft of drafts) releaseImageDraft(draft)
}

function releaseImageDraft(draft: ImageDraft): void {
  if (draft.kind !== 'stored') URL.revokeObjectURL(draft.previewUrl)
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

interface AppendDraftResult {
  drafts: ImageDraft[]
  duplicateOrLimit: number
  unsupported: number
  invalidSize: number
}

function appendImageDrafts(current: readonly ImageDraft[], files: readonly File[]): AppendDraftResult {
  const result: AppendDraftResult = {
    drafts: [...current], duplicateOrLimit: 0, unsupported: 0, invalidSize: 0,
  }
  const knownPaths = new Set(current.flatMap((draft) =>
    draft.kind === 'path' ? [normalizePath(draft.path)] : []))
  const knownMemory = new Set(current.flatMap((draft) =>
    draft.kind === 'memory' ? [draft.file] : []))

  for (const file of files) {
    if (result.drafts.length >= MAX_IMAGE_DRAFTS) {
      result.duplicateOrLimit++
      continue
    }
    if (file.size <= 0 || file.size > MAX_IMAGE_DRAFT_BYTES) {
      result.invalidSize++
      continue
    }
    const path = getLocalPath(file)
    const normalizedPath = normalizePath(path)
    if (path ? knownPaths.has(normalizedPath) : knownMemory.has(file)) {
      result.duplicateOrLimit++
      continue
    }
    if (!supportsImageFile(file)) {
      result.unsupported++
      continue
    }
    if (path) knownPaths.add(normalizedPath)
    else knownMemory.add(file)
    const previewUrl = URL.createObjectURL(file)
    const base = { id: previewUrl, name: file.name || 'clipboard-image', previewUrl }
    result.drafts.push(path ? { ...base, kind: 'path', path } : { ...base, kind: 'memory', file })
  }
  return result
}

function formatDraftError(result: AppendDraftResult): string | null {
  const details: string[] = []
  if (result.duplicateOrLimit) details.push(`重复或超过 ${MAX_IMAGE_DRAFTS} 张：${result.duplicateOrLimit} 张`)
  if (result.unsupported) details.push(`非 PNG/JPEG/WebP：${result.unsupported} 张`)
  if (result.invalidSize) details.push(`为空或超过 20 MB：${result.invalidSize} 张`)
  return details.length ? `部分图片未添加（${details.join('；')}）` : null
}

function getLocalPath(file: File): string {
  try {
    return window.whycode.getPathForFile(file)
  } catch {
    return ''
  }
}

function supportsImageFile(file: File): boolean {
  return SUPPORTED_IMAGE_TYPES.has(file.type.toLowerCase())
    || /\.(?:png|jpe?g|webp)$/i.test(file.name)
}

function formatBytes(bytes: number): string {
  return bytes < 1_000_000
    ? `${(bytes / 1_000).toFixed(1)} KB`
    : `${(bytes / 1_000_000).toFixed(2)} MB`
}
