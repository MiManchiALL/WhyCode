interface ClipboardItemLike {
  kind: string
  getAsFile(): File | null
}

interface ClipboardDataLike {
  items: ArrayLike<ClipboardItemLike>
  files: ArrayLike<File>
}

/** 只认剪贴板中的图片文件；没有图片时调用方必须保留普通文本粘贴。 */
export function collectPastedImageFiles(data: ClipboardDataLike): File[] {
  const itemFiles: File[] = []
  for (let index = 0; index < data.items.length; index++) {
    const item = data.items[index]
    if (item?.kind !== 'file') continue
    const file = item.getAsFile()
    if (file && looksLikeImage(file)) itemFiles.push(file)
  }
  if (itemFiles.length > 0) return itemFiles

  return Array.from(data.files).filter(looksLikeImage)
}

function looksLikeImage(file: File): boolean {
  return file.type.toLowerCase().startsWith('image/')
    || /\.(?:png|jpe?g|webp|gif)$/i.test(file.name)
}
