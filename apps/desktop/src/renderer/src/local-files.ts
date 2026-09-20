export function filePathKey(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

export function displayFilePath(path: string, workingDirectory: string | null): string {
  if (!workingDirectory) return path
  const prefix = `${workingDirectory.replace(/[\\/]+$/u, '')}/`
  return filePathKey(path).startsWith(filePathKey(prefix)) ? path.slice(prefix.length) : path
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
