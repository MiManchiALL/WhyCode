import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { ImageAttachment } from '@whycode/core'
import { USER_IMAGE_ATTACHMENT_MAX_COUNT } from '@whycode/core/image-limits'
import {
  appendImageDrafts,
  formatImageDraftError,
  releaseImageDrafts,
  type ImageDraft,
} from './image-draft.ts'
import { ImagePreviewDialog, type ImagePreviewTarget } from './image-preview.tsx'
import type { BrowserReferenceImage } from '../../shared/browser-reference.ts'
import { BrowserReferenceChip } from './browser-reference-chip.tsx'

export function useImageDrafts(onError: (message: string) => void) {
  const [drafts, setDrafts] = useState<ImageDraft[]>([])
  const draftsRef = useRef<ImageDraft[]>([])

  useEffect(() => () => releaseImageDrafts(draftsRef.current), [])

  const replace = useCallback((next: ImageDraft[]) => {
    draftsRef.current = next
    setDrafts(next)
  }, [])

  const replaceAll = useCallback((next: ImageDraft[]) => {
    releaseImageDrafts(draftsRef.current)
    replace(next)
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

  const addReference = useCallback((image: BrowserReferenceImage, replaceId?: string): boolean => {
    const previous = replaceId ? draftsRef.current.find(draft => draft.id === replaceId) : undefined
    if (replaceId && !previous) { onError('原引用已不在草稿中，请重新添加'); return false }
    if (!previous && draftsRef.current.length >= USER_IMAGE_ATTACHMENT_MAX_COUNT) {
      onError(`每条消息最多添加 ${USER_IMAGE_ATTACHMENT_MAX_COUNT} 张图片或网页引用`); return false
    }
    const file = new File([new Uint8Array(image.bytes)], '网页引用.jpg', { type: 'image/jpeg' })
    const previewUrl = URL.createObjectURL(file)
    // 图片内容变化使用新身份，沿用 IndexedDB 的新增/移除事务，避免复用旧图片字节。
    const draft: ImageDraft = { kind: 'memory', id: crypto.randomUUID(), name: file.name, file, previewUrl, source: image.source, browserId: image.browserId }
    replace(previous ? draftsRef.current.map(item => item === previous ? draft : item) : [...draftsRef.current, draft])
    if (previous) releaseImageDrafts([previous])
    return true
  }, [onError, replace])

  return { drafts, addFiles, remove, replaceAll, detach, restore, addReference }
}

export function ImageDraftStrip({
  drafts,
  onRemove,
  onEditReference,
}: {
  drafts: readonly ImageDraft[]
  onRemove?: (id: string) => void
  onEditReference?: (id: string) => void
}) {
  const [previewId, setPreviewId] = useState<string | null>(null)
  if (drafts.length === 0) return null
  return (
    <>
      <div className="mb-2 flex flex-wrap gap-2">
        <BrowserReferenceChip items={drafts.flatMap(draft => draft.source ? [{ id: draft.id, previewUrl: draft.previewUrl, source: draft.source }] : [])}
          onRemove={onRemove} onEdit={onEditReference} onPreview={setPreviewId} />
        {drafts.filter(draft => !draft.source).map((draft) => (
          <div key={draft.id} className="group/image relative h-20 w-20 overflow-hidden rounded-lg border border-[var(--wc-line)] bg-[var(--wc-surface)]">
            <button
              type="button"
              className="block h-full w-full cursor-zoom-in"
              onClick={() => setPreviewId(draft.id)}
              aria-label={`查看 ${draft.name}`}
            >
              <img src={draft.previewUrl} alt={draft.name} className="h-full w-full object-cover" />
            </button>
            {onRemove && <button
              type="button"
              className="wc-focus-ring pointer-events-none absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-black/65 text-white opacity-0 group-hover/image:pointer-events-auto group-hover/image:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 hover:bg-black/80"
              onClick={() => onRemove(draft.id)}
              title="移除图片"
              aria-label={`移除 ${draft.name}`}
            >
              <X size={12} aria-hidden="true" />
            </button>}
          </div>
        ))}
      </div>
      <ImagePreviewDialog selectedId={previewId} onSelect={setPreviewId}
        targets={drafts.map(draft => ({ id: draft.id, src: draft.previewUrl, name: draft.source?.page.title || draft.name }))} />
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
  const targets = (attachments ?? []).map(attachment => ({
    id: attachment.id,
    src: `whycode-attachment://${attachment.sessionId}/${encodeURIComponent(attachment.storageName)}`,
    name: (attachment.source?.kind === 'browser-reference' && attachment.source.page.title) || attachment.name,
    details: `${attachment.width}×${attachment.height} · ${formatBytes(attachment.byteLength)}`,
    source: attachment.source,
  }))
  return <ImageGallery targets={targets} variant={variant} />
}

export function PendingImageGallery({ drafts }: { drafts: readonly ImageDraft[] }) {
  return <ImageGallery variant="message" targets={drafts.map(draft => ({
    id: draft.id,
    src: draft.previewUrl,
    name: draft.source?.page.title || draft.name,
    source: draft.source,
  }))} />
}

function ImageGallery({ targets, variant }: {
  targets: readonly (ImagePreviewTarget & Pick<ImageAttachment, 'source'>)[]
  variant: 'message' | 'tool'
}) {
  const [previewId, setPreviewId] = useState<string | null>(null)
  if (!targets.length) return null
  return (
    <>
      <div className={variant === 'message'
        ? 'flex max-w-full flex-wrap justify-end gap-2'
        : 'mb-2 flex flex-wrap gap-2'}>
        <BrowserReferenceChip items={targets.flatMap(item => item.source?.kind === 'browser-reference' ? [{
          id: item.id, previewUrl: item.src, source: item.source,
        }] : [])} onPreview={setPreviewId} />
        {targets.filter(item => item.source?.kind !== 'browser-reference').map(target => (
          <button
            key={target.id}
            type="button"
            className={variant === 'message'
              ? 'cursor-zoom-in overflow-hidden rounded-xl border border-[var(--wc-line)] bg-white shadow-[1px_2px_0_rgb(43_46_41_/_5%)] transition-transform hover:-translate-y-0.5'
              : 'cursor-zoom-in rounded border border-neutral-300 bg-white p-0.5'}
            onClick={() => setPreviewId(target.id)}
            title={[target.name, target.details, '点击查看原图'].filter(Boolean).join(' · ')}
          >
            <img
              src={target.src}
              alt={target.name}
              loading="lazy"
              className={variant === 'message'
                ? 'h-24 w-24 object-cover'
                : 'max-h-56 max-w-72 object-contain'}
            />
          </button>
        ))}
      </div>
      <ImagePreviewDialog targets={targets} selectedId={previewId} onSelect={setPreviewId} />
    </>
  )
}

export function QueuedImageStrip({ attachments }: { attachments?: readonly (ImageAttachment | ImageDraft)[] }) {
  if (!attachments?.length) return null
  return (
    <div className="mt-1 flex gap-1">
      {attachments.map((attachment) => (
        <img
          key={attachment.id}
          src={'previewUrl' in attachment
            ? attachment.previewUrl
            : `whycode-attachment://${attachment.sessionId}/${encodeURIComponent(attachment.storageName)}`}
          alt={attachment.name}
          title={'width' in attachment ? `${attachment.name} · ${attachment.width}×${attachment.height}` : attachment.name}
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
