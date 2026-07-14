import { useCallback, useRef, useState, type DragEvent } from 'react'

interface ImageDropOptions {
  canAttachImages: boolean
  interactionBusy: boolean
  onFiles: (files: readonly File[]) => void
  onError: (message: string) => void
}

export function useImageDropTarget(options: ImageDropOptions) {
  const { canAttachImages, interactionBusy, onFiles, onError } = options
  const [active, setActive] = useState(false)
  const depth = useRef(0)

  const reset = useCallback(() => {
    depth.current = 0
    setActive(false)
  }, [])

  const onDragEnter = useCallback((event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    depth.current++
    setActive(true)
  }, [])

  const onDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = canAttachImages && !interactionBusy ? 'copy' : 'none'
  }, [canAttachImages, interactionBusy])

  const onDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) reset()
  }, [reset])

  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    if (!isFileDrag(event.dataTransfer)) return
    event.preventDefault()
    const files = collectDroppedFiles(event.dataTransfer)
    reset()
    if (files.length === 0) return
    if (!canAttachImages) {
      onError('当前模型不支持拖放图片；请切换到带“图片”标记的模型')
      return
    }
    if (interactionBusy) {
      onError('Agent 工作中；图片只能在空闲时拖放，不能排队或立即插话')
      return
    }
    onFiles(files)
  }, [canAttachImages, interactionBusy, onError, onFiles, reset])

  return {
    active,
    handlers: { onDragEnter, onDragOver, onDragLeave, onDrop, onDragEnd: reset },
  }
}

export function isFileDrag(dataTransfer: Pick<DataTransfer, 'types'>): boolean {
  return Array.from(dataTransfer.types).includes('Files')
}

export function collectDroppedFiles(
  dataTransfer: Pick<DataTransfer, 'files'>,
): File[] {
  return Array.from(dataTransfer.files)
}
