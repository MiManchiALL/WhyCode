import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImageAttachment } from '@whycode/core'
import { USER_IMAGE_ATTACHMENT_MAX_COUNT } from '@whycode/core/image-limits'
import {
  appendImageDrafts,
  formatImageDraftError,
  releaseImageDrafts,
  type ImageDraft,
} from './image-draft.ts'
import { ImagePreviewDialog, type ImagePreviewTarget } from './image-preview.tsx'

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
    const error = formatImageDraftError(result)
    if (error) onError(error)
  }, [onError, replace])

  const remove = useCallback((id: string) => {
    const next = draftsRef.current.filter((draft) => {
      if (draft.id !== id) return true
      releaseImageDrafts([draft])
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
      releaseImageDrafts([duplicate])
    }
    const candidates = rejected.filter((draft) => !known.has(draft.id))
    const restored = candidates.slice(0, Math.max(
      0,
      USER_IMAGE_ATTACHMENT_MAX_COUNT - current.length,
    ))
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

export function UserImageGallery({
  attachments,
  variant = 'message',
}: {
  attachments?: readonly ImageAttachment[]
  variant?: 'message' | 'tool'
}) {
  const [preview, setPreview] = useState<ImagePreviewTarget | null>(null)
  if (!attachments?.length) return null
  return (
    <>
      <div className={variant === 'message'
        ? 'flex max-w-full flex-wrap justify-end gap-2'
        : 'mb-2 flex flex-wrap gap-2'}>
        {attachments.map((attachment) => {
          const src = `whycode-attachment://${attachment.sessionId}/${encodeURIComponent(attachment.storageName)}`
          const details = `${attachment.width}×${attachment.height} · ${formatBytes(attachment.byteLength)}`
          return (
            <button
              key={attachment.id}
              type="button"
              className={variant === 'message'
                ? 'cursor-zoom-in overflow-hidden rounded-xl border border-[var(--wc-line)] bg-white shadow-[1px_2px_0_rgb(43_46_41_/_5%)] transition-transform hover:-translate-y-0.5'
                : 'cursor-zoom-in rounded border border-neutral-300 bg-white p-0.5'}
              onClick={() => setPreview({ src, name: attachment.name, details })}
              title={`${attachment.name} · ${details} · 点击查看原图`}
            >
              <img
                src={src}
                alt={attachment.name}
                loading="lazy"
                className={variant === 'message'
                  ? 'h-24 w-24 object-cover'
                  : 'max-h-56 max-w-72 object-contain'}
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

function formatBytes(bytes: number): string {
  return bytes < 1_000_000
    ? `${(bytes / 1_000).toFixed(1)} KB`
    : `${(bytes / 1_000_000).toFixed(2)} MB`
}
