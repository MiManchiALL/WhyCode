import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Client } from 'ssh2'
import { localWorkspaceIO, readBoundedWorkspaceFile, type WorkspaceFileSystem, type WorkspaceIO } from '@whycode/core'
import { sshSkillIdSchema } from '../../shared/ssh-skills.ts'
import { ordinaryDirectory } from './config-files.ts'
import { remoteSkillDigest } from './skill-digest.ts'

export const SKILL_SYNC_MARKER = '.whycode-skill-sync.json'
export const SKILL_SYNC_BYTES = 20 * 1024 * 1024
const MAX_ENTRIES = 2000
export interface SkillTree { digest: string; bytes: number; directories: string[]; files: { path: string; data: Buffer; mode: number }[] }
export interface SkillTreeManifest { bytes: number; directories: string[]; files: { path: string; absolute: string; size: number; mode: number }[] }
export interface SkillWorkspaceIO extends WorkspaceIO { digestSkillTree?: (manifest: SkillTreeManifest) => Promise<string> }

export function remoteSkillIO(fs: WorkspaceFileSystem, home: string, client: Client): SkillWorkspaceIO {
  return { identity: `skill-sync:${home}`, platform: 'linux', path: path.posix, fs, digestSkillTree: manifest => remoteSkillDigest(client, manifest) }
}
export function skillPath(root: string, id: string, paths: typeof path): string {
  return paths.join(root, ...sshSkillIdSchema.parse(id).split('/'))
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

async function scanSkillTree(io: WorkspaceIO, root: string): Promise<SkillTreeManifest> {
  if (!await ordinaryDirectory(io, root)) throw new Error(`Skill 目录已不存在：${root}`)
  const directories: string[] = []
  const files: SkillTreeManifest['files'] = []
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
        files.push({ path: relative, absolute, size: info.size, mode: info.mode & 0o111 ? 0o700 : 0o600 })
      } else throw new Error(`Skill 内含不支持的文件：${relative}`)
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  directories.sort((a, b) => a.localeCompare(b, 'en'))
  return { bytes, directories, files }
}

export async function skillTreeDigest(io: SkillWorkspaceIO, root: string): Promise<string> {
  return io.digestSkillTree
    ? io.digestSkillTree(await scanSkillTree(io, root))
    : (await readSkillTree(io, root)).digest
}

export async function readSkillTree(io: WorkspaceIO, root: string): Promise<SkillTree> {
  const manifest = await scanSkillTree(io, root)
  const files = await mapSkillFiles(manifest.files, async file => {
    const data = await readBoundedWorkspaceFile(file.absolute, file.size, io)
    if (data.length !== file.size) throw new Error('Skill 文件在读取时发生变化，请重试')
    return { path: file.path, data, mode: file.mode }
  })
  const { bytes, directories } = manifest
  const hash = createHash('sha256')
  for (const directory of directories) hash.update(`d\0${directory}\0`)
  for (const file of files) hash.update(`f\0${file.path}\0${file.mode}\0${file.data.length}\0`).update(file.data)
  return { digest: hash.digest('hex'), bytes, files, directories }
}

export { localWorkspaceIO }
