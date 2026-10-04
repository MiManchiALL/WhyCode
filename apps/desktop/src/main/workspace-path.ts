import { isAbsolute, relative, resolve, sep } from 'node:path'

export function pathKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right)
}

export function directoriesOverlap(left: string, right: string): boolean {
  return containsPath(left, right) || containsPath(right, left)
}

export function containsPath(parent: string, child: string): boolean {
  const suffix = relative(pathKey(parent), pathKey(child))
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}
