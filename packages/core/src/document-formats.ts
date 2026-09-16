export type DocumentFormat = 'code' | 'markdown' | 'html' | 'image' | 'pdf' | 'unsupported'

export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif',
}
export function documentFormat(path: string): DocumentFormat {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  if (Object.hasOwn(IMAGE_MEDIA_TYPES, extension)) return 'image'
  if (extension === 'html' || extension === 'htm') return 'html'
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  if (extension === 'pdf') return 'pdf'
  if (/^(docx?|pptx?|xlsx?|odt|odp|ods|zip|7z|rar|exe|dll|msi|sqlite|db|mp[34]|mov|webm|wav|ogg)$/u.test(extension)) return 'unsupported'
  return 'code'
}

export function isPresentableFile(path: string): boolean {
  const format = documentFormat(path)
  return format === 'html' || format === 'markdown' || format === 'image' || format === 'pdf'
}
