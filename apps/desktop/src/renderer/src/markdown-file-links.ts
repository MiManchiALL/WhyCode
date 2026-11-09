export interface MarkdownFileTarget {
  path: string
  line?: number
}

/** 先拆位置再解码，让文件名中的 %23 和 %3A 保持字面含义。 */
export function markdownFileTarget(url: string): MarkdownFileTarget | null {
  const hash = url.indexOf('#')
  const destination = hash < 0 ? url : url.slice(0, hash)
  if (!destination || destination.includes('?')) return null
  const suffix = hash < 0 && /[.\\/]/u.test(destination) ? /:(\d+)(?::\d+|-\d+)?$/u.exec(destination) : null
  const location = hash < 0 ? suffix?.[1] : /^L(\d+)(?:-L?\d+)?$/iu.exec(url.slice(hash + 1))?.[1]
  const encodedPath = suffix ? destination.slice(0, suffix.index) : destination
  let path: string
  try {
    path = decodeURIComponent(encodedPath.replace(/%(?![\da-f]{2})/giu, '%25'))
  } catch {
    return null
  }
  if (/^[\\/]{2}|[\\/]$|[\u0000-\u001f\u007f]/u.test(path)
    || /^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[a-z]:[\\/]/iu.test(path)) return null
  const line = Number(location)
  return Number.isSafeInteger(line) && line > 0 ? { path, line } : { path }
}
