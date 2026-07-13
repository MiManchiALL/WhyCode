import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImageAttachment } from '@whycode/core'

export interface ImageDraft {
  path: string
  name: string
  previewUrl: string
}

/** UI 预检镜像；安全上限仍由 Core/Main 的同值常量权威执行。 */
export const MAX_IMAGE_DRAFTS = 4

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

  const addFiles = useCallback((files: FileList | null) => {
    if (!files?.length) return
    const next = [...draftsRef.current]
    const knownPaths = new Set(next.map((draft) => normalizePath(draft.path)))
    let omitted = 0
    for (const file of files) {
      if (next.length >= MAX_IMAGE_DRAFTS) {
        omitted++
        continue
      }
      let path = ''
      try {
        path = window.whycode.getPathForFile(file)
      } catch {
        omitted++
        continue
      }
      const normalized = normalizePath(path)
      if (!path || knownPaths.has(normalized)) {
        omitted++
        continue
      }
      knownPaths.add(normalized)
      next.push({ path, name: file.name, previewUrl: URL.createObjectURL(file) })
    }
    replace(next)
    if (omitted > 0) {
      onError(`每条消息最多添加 ${MAX_IMAGE_DRAFTS} 张且不能重复；已忽略 ${omitted} 张`)
    }
  }, [onError, replace])

  const remove = useCallback((path: string) => {
    const next = draftsRef.current.filter((draft) => {
      if (draft.path !== path) return true
      URL.revokeObjectURL(draft.previewUrl)
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
    const known = new Set(current.map((draft) => normalizePath(draft.path)))
    for (const duplicate of rejected.filter((draft) => known.has(normalizePath(draft.path)))) {
      URL.revokeObjectURL(duplicate.previewUrl)
    }
    const candidates = rejected.filter((draft) => !known.has(normalizePath(draft.path)))
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
  onRemove: (path: string) => void
}) {
  if (drafts.length === 0) return null
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {drafts.map((draft) => (
        <div key={draft.path} className="group relative h-20 w-20 overflow-hidden rounded border border-neutral-200 bg-white">
          <img src={draft.previewUrl} alt={draft.name} className="h-full w-full object-cover" />
          <button
            className="absolute right-1 top-1 rounded bg-black/65 px-1.5 py-0.5 text-xs text-white opacity-80 hover:opacity-100"
            onClick={() => onRemove(draft.path)}
            title={`移除 ${draft.name}`}
            aria-label={`移除 ${draft.name}`}
          >
            ×
          </button>
          <div className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-[10px] text-white">
            {draft.name}
          </div>
        </div>
      ))}
    </div>
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
            ? `添加图片（最多 ${MAX_IMAGE_DRAFTS} 张）`
            : supportsImageInput
              ? 'Agent 工作中；图片消息不能排队或立即插话'
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
  if (!attachments?.length) return null
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <img
          key={attachment.id}
          src={`whycode-attachment://${attachment.sessionId}/${encodeURIComponent(attachment.storageName)}`}
          alt={attachment.name}
          title={`${attachment.name} · ${attachment.width}×${attachment.height}`}
          loading="lazy"
          className="max-h-56 max-w-72 rounded border border-neutral-300 bg-white object-contain"
        />
      ))}
    </div>
  )
}

export function releaseImageDrafts(drafts: readonly ImageDraft[]): void {
  for (const draft of drafts) URL.revokeObjectURL(draft.previewUrl)
}

function normalizePath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}
