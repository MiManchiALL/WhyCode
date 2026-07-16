import { useCallback, useRef, useState, type DragEvent } from 'react'

interface AttachmentDropOptions {
  canAttachImages: boolean
  canAttachPdfs: boolean
  interactionBusy: boolean
  onImageFiles: (files: readonly File[]) => void
  onPdfFiles: (files: readonly File[]) => void
  onError: (message: string) => void
}

export function useAttachmentDropTarget(options: AttachmentDropOptions) {
  const {
    canAttachImages,
    canAttachPdfs,
    interactionBusy,
    onImageFiles,
    onPdfFiles,
    onError,
  } = options
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
    event.dataTransfer.dropEffect = (canAttachImages || canAttachPdfs) && !interactionBusy
      ? 'copy'
      : 'none'
  }, [canAttachImages, canAttachPdfs, interactionBusy])

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
    if (interactionBusy) {
      onError('当前操作暂时锁定附件，请稍后重试')
      return
    }
    const classified = classifyAttachmentFiles(files)
    if (classified.pdfs.length > 0) {
      if (canAttachPdfs) onPdfFiles(classified.pdfs)
      else onError('当前没有可用模型，无法添加 PDF')
    }
    if (classified.images.length > 0) {
      if (canAttachImages) onImageFiles(classified.images)
      else onError('当前模型不支持拖放图片；PDF 仍可添加')
    }
    if (classified.unsupported.length > 0) {
      onError(`仅支持 PNG、JPEG、WebP 和 PDF；已忽略 ${classified.unsupported.length} 个文件`)
    }
  }, [
    canAttachImages,
    canAttachPdfs,
    interactionBusy,
    onError,
    onImageFiles,
    onPdfFiles,
    reset,
  ])

  return {
    active,
    handlers: { onDragEnter, onDragOver, onDragLeave, onDrop, onDragEnd: reset },
  }
}

export function classifyAttachmentFiles(files: readonly File[]): {
  images: File[]
  pdfs: File[]
  unsupported: File[]
} {
  const result: { images: File[]; pdfs: File[]; unsupported: File[] } = {
    images: [], pdfs: [], unsupported: [],
  }
  for (const file of files) {
    if (file.type.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      result.pdfs.push(file)
    } else if (
      ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(file.type.toLowerCase())
      || /\.(?:png|jpe?g|webp)$/i.test(file.name)
    ) {
      result.images.push(file)
    } else {
      result.unsupported.push(file)
    }
  }
  return result
}

export function isFileDrag(dataTransfer: Pick<DataTransfer, 'types'>): boolean {
  return Array.from(dataTransfer.types).includes('Files')
}

export function collectDroppedFiles(
  dataTransfer: Pick<DataTransfer, 'files'>,
): File[] {
  return Array.from(dataTransfer.files)
}
