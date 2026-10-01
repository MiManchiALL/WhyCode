import { createHash } from 'node:crypto'
import path from 'node:path'
import { localWorkspaceIO, readBoundedWorkspaceFile, type WorkspaceFileSystem, type WorkspaceIO } from '@whycode/core'
import { sshSkillIdSchema } from '../../shared/ssh-skills.ts'

export const SKILL_SYNC_MARKER = '.whycode-skill-sync.json'
export const SKILL_SYNC_BYTES = 20 * 1024 * 1024
const MAX_ENTRIES = 2000
export interface SkillTree { digest: string; bytes: number; directories: string[]; files: { path: string; data: Buffer; mode: number }[] }

export function remoteSkillIO(fs: WorkspaceFileSystem, home: string): WorkspaceIO {
  return { identity: `skill-sync:${home}`, platform: 'linux', path: path.posix, fs }
}
export function skillPath(root: string, id: string, paths: typeof path): string {
  return paths.join(root, ...sshSkillIdSchema.parse(id).split('/'))
}
export async function exists(fs: WorkspaceFileSystem, file: string) {
  try { return await fs.lstat(file) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

/** 每一层都拒绝链接；删除和发布不能借助用户目录中的链接越界。 */
export async function ordinaryDirectory(io: WorkspaceIO, root: string, create = false): Promise<boolean> {
  const parent = io.path.dirname(root)
  if (parent !== root && !await ordinaryDirectory(io, parent, create)) return false
  let info = await exists(io.fs, root)
  if (!info && create) {
    try { await io.fs.mkdir(root, { mode: 0o700 }) }
    catch (error) { if (!await exists(io.fs, root)) throw error }
    info = await exists(io.fs, root)
  }
  if (!info) return false
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Skill 目录不是普通目录：${root}`)
  return true
}

export async function mapSkillFiles<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = []
  let cursor = 0
  let failure: unknown
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (!failure && cursor < items.length) {
      const index = cursor++
      try { result[index] = await work(items[index]!) } catch (error) { failure = error }
    }
  }))
  if (failure) throw failure
  return result
}

export async function readSkillTree(io: WorkspaceIO, root: string): Promise<SkillTree> {
  if (!await ordinaryDirectory(io, root)) throw new Error(`Skill 目录已不存在：${root}`)
  const directories: string[] = []
  const paths: { relative: string; absolute: string; size: number; mode: number }[] = []
  const pending = [{ absolute: root, relative: '', depth: 0 }]
  let count = 0
  let bytes = 0
  for (let index = 0; index < pending.length; index++) {
    const current = pending[index]!
    for (const entry of await io.fs.readdir(current.absolute, { withFileTypes: true })) {
      if (++count > MAX_ENTRIES) throw new Error('Skill 文件数量超过 2000 项，请精简后同步')
      if (entry.name === SKILL_SYNC_MARKER && current.relative === '') continue
      if (entry.name === '.' || entry.name === '..' || /[/\\\0]/u.test(entry.name)) throw new Error('Skill 文件名无效')
      const absolute = io.path.join(current.absolute, entry.name)
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name
      const info = entry.mode ? entry : await io.fs.lstat(absolute)
      if (info.isSymbolicLink()) throw new Error(`Skill 内含符号链接，无法同步或自动清理：${relative}`)
      if (info.isDirectory()) {
        if (current.depth >= 16) throw new Error('Skill 资源目录过深')
        directories.push(relative); pending.push({ absolute, relative, depth: current.depth + 1 })
      } else if (info.isFile()) {
        bytes += info.size
        if (bytes > SKILL_SYNC_BYTES) throw new Error('Skill 内容超过单次 20 MiB 同步上限')
        paths.push({ relative, absolute, size: info.size, mode: info.mode & 0o111 ? 0o700 : 0o600 })
      } else throw new Error(`Skill 内含不支持的文件：${relative}`)
    }
  }
  const files = await mapSkillFiles(paths, async file => {
    const data = await readBoundedWorkspaceFile(file.absolute, file.size, io)
    if (data.length !== file.size) throw new Error('Skill 文件在读取时发生变化，请重试')
    return { path: file.relative, data, mode: file.mode }
  })
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  directories.sort((a, b) => a.localeCompare(b, 'en'))
  const hash = createHash('sha256')
  for (const directory of directories) hash.update(`d\0${directory}\0`)
  for (const file of files) hash.update(`f\0${file.path}\0${file.mode}\0${file.data.length}\0`).update(file.data)
  return { digest: hash.digest('hex'), bytes, files, directories }
}

export async function pruneSkillParents(io: WorkspaceIO, directory: string, stop: string): Promise<void> {
  for (let current = directory; current !== stop; current = io.path.dirname(current)) {
    if (!await ordinaryDirectory(io, current)) continue
    if ((await io.fs.readdir(current, { withFileTypes: true })).length > 0) break
    try { await io.fs.rmdir(current) }
    catch (error) {
      if ((await io.fs.readdir(current, { withFileTypes: true })).length > 0) break
      throw error
    }
  }
}

export { localWorkspaceIO }
