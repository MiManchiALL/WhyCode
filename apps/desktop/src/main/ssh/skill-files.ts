import { createHash } from 'node:crypto'
import path from 'node:path'
import type { Client } from 'ssh2'
import { localWorkspaceIO, readBoundedWorkspaceFile, type WorkspaceFileSystem, type WorkspaceIO } from '@whycode/core'
import { sshSkillIdSchema } from '../../shared/ssh-skills.ts'
import { FILE_CONCURRENCY, mapFileOperations, ordinaryDirectory } from './config-files.ts'
import { remoteSkillDigest } from './skill-digest.ts'

export const SKILL_SYNC_MARKER = '.whycode-skill-sync.json'
export const SKILL_SYNC_BYTES = 20 * 1024 * 1024
const MAX_ENTRIES = 2000
export interface SkillTree { digest: string; bytes: number; directories: string[]; files: { path: string; data: Buffer; mode: number }[] }
export interface SkillTreeManifest { bytes: number; directories: string[]; files: { path: string; absolute: string; size: number; mode: number }[] }
export interface SkillWorkspaceIO extends WorkspaceIO { digestSkillTree?: (manifest: SkillTreeManifest) => Promise<string> }

export function remoteSkillIO(fs: WorkspaceFileSystem, home: string, client: Client): SkillWorkspaceIO {
  // SFTP 可以并发准备清单。一次管理操作只占一个额外 exec 名额，兼容限制会话通道数的服务器。
  let ready = Promise.resolve()
  return {
    identity: `skill-sync:${home}`, platform: 'linux', path: path.posix, fs,
    digestSkillTree(manifest) {
      const digest = ready.then(() => remoteSkillDigest(client, manifest))
      ready = digest.then(() => {}, () => {})
      return digest
    },
  }
}
export function skillPath(root: string, id: string, paths: typeof path): string {
  return paths.join(root, ...sshSkillIdSchema.parse(id).split('/'))
}

async function scanSkillTree(io: WorkspaceIO, root: string, directoryConcurrency: number): Promise<SkillTreeManifest> {
  if (!await ordinaryDirectory(io, root)) throw new Error(`Skill 目录已不存在：${root}`)
  const directories: string[] = []
  const files: SkillTreeManifest['files'] = []
  const pending = [{ absolute: root, relative: '', depth: 0 }]
  let count = 0
  let bytes = 0
  for (let index = 0; index < pending.length;) {
    const batch = pending.slice(index, index + directoryConcurrency)
    index += batch.length
    const listings = await mapFileOperations(batch, async current => {
      const entries = await io.fs.readdir(current.absolute, { withFileTypes: true })
      count += entries.length
      if (count > MAX_ENTRIES) throw new Error('Skill 文件数量超过 2000 项，请精简后同步')
      return { current, entries }
    })
    for (const { current, entries } of listings) {
      for (const entry of entries) {
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
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'))
  directories.sort((a, b) => a.localeCompare(b, 'en'))
  return { bytes, directories, files }
}

export async function skillTreeDigest(io: SkillWorkspaceIO, root: string, concurrency = FILE_CONCURRENCY): Promise<string> {
  return io.digestSkillTree
    ? io.digestSkillTree(await scanSkillTree(io, root, concurrency))
    : (await readSkillTree(io, root, concurrency)).digest
}

export async function readSkillTree(io: WorkspaceIO, root: string, concurrency = FILE_CONCURRENCY): Promise<SkillTree> {
  const manifest = await scanSkillTree(io, root, concurrency)
  const files = await mapFileOperations(manifest.files, async file => {
    const data = await readBoundedWorkspaceFile(file.absolute, file.size, io)
    if (data.length !== file.size) throw new Error('Skill 文件在读取时发生变化，请重试')
    return { path: file.path, data, mode: file.mode }
  }, concurrency)
  const { bytes, directories } = manifest
  const hash = createHash('sha256')
  for (const directory of directories) hash.update(`d\0${directory}\0`)
  for (const file of files) hash.update(`f\0${file.path}\0${file.mode}\0${file.data.length}\0`).update(file.data)
  return { digest: hash.digest('hex'), bytes, files, directories }
}

export { localWorkspaceIO }
