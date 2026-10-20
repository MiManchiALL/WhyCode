const ATTACHMENT_PREFIX = 'attachment://'
const ATTACHMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export function attachmentReference(id: string): string {
  return `${ATTACHMENT_PREFIX}${id}`
}

export function isAttachmentReference(path: string): boolean {
  return path.startsWith(ATTACHMENT_PREFIX)
}

export function attachmentReferenceId(path: string): string | null {
  const id = path.slice(ATTACHMENT_PREFIX.length)
  return isAttachmentReference(path) && ATTACHMENT_ID.test(id) ? id : null
}

/** 工具分派与界面摘要使用同一文件类型规则。 */
export function fileReadKind(path: string): 'text' | 'image' | 'pdf' {
  if (isAttachmentReference(path) || /\.pdf$/iu.test(path)) return 'pdf'
  // SVG 等源文件仍按文本读取；图片附件只接受这三种栅格格式。
  return /\.(?:png|jpe?g|webp)$/iu.test(path) ? 'image' : 'text'
}

export function parsePageRange(pages: string): { startPage: number; pageCount: number } | null {
  const match = /^([1-9]\d*)(?:-([1-9]\d*))?$/u.exec(pages)
  if (!match) return null
  const startPage = Number(match[1])
  const endPage = Number(match[2] ?? match[1])
  return Number.isSafeInteger(startPage) && Number.isSafeInteger(endPage) && endPage >= startPage
    ? { startPage, pageCount: endPage - startPage + 1 }
    : null
}
