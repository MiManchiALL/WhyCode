import { useEffect, useRef } from 'react'

export interface ImagePreviewTarget {
  src: string
  name: string
  details?: string
}

export function ImagePreviewDialog({
  target,
  onClose,
}: {
  target: ImagePreviewTarget | null
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || !target) return
    if (!dialog.open) dialog.showModal()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [target])

  if (!target) return null
  return (
    <dialog
      ref={dialogRef}
      className="m-auto max-h-[92vh] max-w-[92vw] rounded-lg bg-neutral-950 p-0 text-white shadow-2xl backdrop:bg-black/75"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      aria-label={`查看图片 ${target.name}`}
    >
      <div className="flex max-h-[92vh] max-w-[92vw] flex-col">
        <div className="flex items-center gap-4 border-b border-white/15 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{target.name}</div>
            {target.details ? <div className="text-xs text-neutral-400">{target.details}</div> : null}
          </div>
          <button
            type="button"
            className="rounded px-2 py-1 text-xl leading-none text-neutral-300 hover:bg-white/10 hover:text-white"
            onClick={onClose}
            aria-label="关闭图片预览"
            title="关闭（Esc）"
            autoFocus
          >
            ×
          </button>
        </div>
        <div className="min-h-0 overflow-auto p-4">
          <img
            src={target.src}
            alt={target.name}
            className="mx-auto max-h-[80vh] max-w-[86vw] object-contain"
          />
        </div>
      </div>
    </dialog>
  )
}
