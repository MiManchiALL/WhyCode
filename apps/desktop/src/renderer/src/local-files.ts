export function isWindowsAbsolutePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{2})/u.test(path)
}

function slashSeparatedPath(path: string): string {
  // POSIX 绝对路径中的反斜杠是文件名的一部分。
  return path.startsWith('/') && !isWindowsAbsolutePath(path) ? path : path.replaceAll('\\', '/')
}

export function filePathKey(path: string): string {
  const normalized = slashSeparatedPath(path)
  return isWindowsAbsolutePath(path) ? normalized.toLowerCase() : normalized
}

export function displayFilePath(path: string, workingDirectory: string | null): string {
  if (!workingDirectory) return path
  const prefix = `${slashSeparatedPath(workingDirectory).replace(/\/+$/u, '')}/`
  return filePathKey(path).startsWith(filePathKey(prefix)) ? path.slice(prefix.length) : path
}

/** 按工作区的路径拼接相对文件名；盘符、POSIX 根和 UNC 共享根都不能被 .. 弹出。 */
export function resolveWorkspaceFilePath(path: string, projectDir: string | null): string {
  if (!projectDir) return path
  const absolute = path.startsWith('/') || isWindowsAbsolutePath(path)
  const base = absolute ? path : projectDir
  const windows = isWindowsAbsolutePath(base)
  const fullPath = absolute ? path : `${slashSeparatedPath(projectDir).replace(/\/+$/u, '')}/${path}`
  const normalized = slashSeparatedPath(fullPath)
  const root = normalized.match(/^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+\/?|\/)/u)?.[0] ?? ''
  const parts: string[] = []
  for (const part of normalized.slice(root.length).split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  const resolved = root + parts.join('/')
  return windows && base.includes('\\') ? resolved.replaceAll('/', '\\') : resolved
}

export function localFilePath(file: File): string {
  try {
    return window.whycode.getPathForFile(file)
  } catch {
    return ''
  }
}

export function fileName(path: string): string {
  const normalized = slashSeparatedPath(path).replace(/\/+$/u, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || path
}
