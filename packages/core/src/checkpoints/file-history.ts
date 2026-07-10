import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { FileState } from './types.ts'

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

async function collectMissingParents(path: string): Promise<string[]> {
  const missing: string[] = []
  let current = dirname(path)
  while (current !== dirname(current)) {
    if (await lstat(current).then(() => true, () => false)) break
    missing.push(current)
    current = dirname(current)
  }
  return missing
}

/** 捕获精确文件，不经过 .gitignore；因此敏感文件、二进制和项目外路径也可可靠回滚。 */
export async function captureFileState(path: string, blobDir: string): Promise<FileState> {
  const absolute = resolve(path)
  const stats = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!stats) {
    return {
      path: absolute,
      kind: 'missing',
      missingParents: await collectMissingParents(absolute),
    }
  }
  if (!stats.isFile()) {
    throw new Error(`精确回滚只支持普通文件：${absolute}`)
  }
  const content = await readFile(absolute)
  const contentHash = hash(content)
  await mkdir(blobDir, { recursive: true, mode: 0o700 })
  const blobPath = join(blobDir, contentHash)
  await writeFile(blobPath, content, { flag: 'wx', mode: 0o600 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    },
  )
  return {
    path: absolute,
    kind: 'file',
    contentHash,
    blobHash: contentHash,
    size: content.byteLength,
    mode: stats.mode,
    missingParents: [],
  }
}

export async function currentFileMatches(expected: FileState): Promise<boolean> {
  const stats = await lstat(expected.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (expected.kind === 'missing') return stats === null
  if (!stats?.isFile() || stats.size !== expected.size) return false
  return hash(await readFile(expected.path)) === expected.contentHash
}

export async function restoreFileState(state: FileState, blobDir: string): Promise<void> {
  if (state.kind === 'missing') {
    await rm(state.path, { force: true })
    for (const parent of state.missingParents) {
      await rmdir(parent).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error
      })
    }
    return
  }
  if (!state.blobHash) throw new Error(`文件备份缺少内容引用：${state.path}`)
  const content = await readFile(join(blobDir, state.blobHash))
  await mkdir(dirname(state.path), { recursive: true })
  const temp = `${state.path}.${process.pid}.${randomUUID()}.whycode-restore`
  await writeFile(temp, content, { mode: state.mode ?? 0o600, flush: true })
  // Windows rename 不覆盖已有目标；先移除已通过冲突预检的当前版本，再原子放入备份。
  await rm(state.path, { force: true })
  await rename(temp, state.path)
  if (state.mode !== undefined) await chmod(state.path, state.mode).catch(() => {})
}
