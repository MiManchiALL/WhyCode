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
  return collectPastedFiles(data, looksLikeImage)
}

/** PDF 文件粘贴与图片使用同一条本地路径附件链；普通文本仍不被接管。 */
export function collectPastedPdfFiles(data: ClipboardDataLike): File[] {
  return collectPastedFiles(data, looksLikePdf)
}

function collectPastedFiles(
  data: ClipboardDataLike,
  accepts: (file: File) => boolean,
): File[] {
  const itemFiles: File[] = []
  for (let index = 0; index < data.items.length; index++) {
    const item = data.items[index]
    if (item?.kind !== 'file') continue
    const file = item.getAsFile()
    if (file && accepts(file)) itemFiles.push(file)
  }
  if (itemFiles.length > 0) return itemFiles

  return Array.from(data.files).filter(accepts)
}

function looksLikeImage(file: File): boolean {
  return file.type.toLowerCase().startsWith('image/')
    || /\.(?:png|jpe?g|webp|gif)$/i.test(file.name)
}

function looksLikePdf(file: File): boolean {
  return file.type.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(file.name)
}
