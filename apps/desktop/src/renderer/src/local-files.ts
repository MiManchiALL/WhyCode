export function filePathKey(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

export function localFilePath(file: File): string {
  try {
    return window.whycode.getPathForFile(file)
  } catch {
    return ''
  }
}

export function fileName(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || path
}
