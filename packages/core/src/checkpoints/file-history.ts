import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  type FileHandle,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { FileState } from './types.ts'
import {
  CHECKPOINT_FILE_PREVIEW_MAX_BYTES,
  type CheckpointFilePreviewState,
} from './types.ts'

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
  return hashFile(expected.path).then(
    (currentHash) => currentHash === expected.contentHash,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    },
  )
}

/** 分块计算当前文件摘要，避免预览一致性检查把大文件整体读入内存。 */
async function hashFile(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1_024)
    let position = 0
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      digest.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }
    return digest.digest('hex')
  } finally {
    await file.close()
  }
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

/** 预览只读取检查点已经拥有的精确 blob；大文件和二进制不进入 Renderer。 */
export async function readFileStatePreview(
  state: FileState,
  blobDir: string,
): Promise<CheckpointFilePreviewState> {
  if (state.kind === 'missing') return { kind: 'missing' }
  if (!state.blobHash) throw new Error(`文件备份缺少内容引用：${state.path}`)
  return readBoundedTextPreview(join(blobDir, state.blobHash))
}

/** 读取检查点已授权路径的当前状态；不跟踪移动后的文件身份。 */
export async function readCurrentFilePreview(
  path: string,
): Promise<CheckpointFilePreviewState> {
  const absolute = resolve(path)
  const stats = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!stats) return { kind: 'missing' }
  if (!stats.isFile()) throw new Error(`当前路径不是普通文件：${absolute}`)
  return readBoundedTextPreview(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return { kind: 'missing' }
    throw error
  })
}

async function readBoundedTextPreview(path: string): Promise<CheckpointFilePreviewState> {
  const file = await open(path, 'r')
  try {
    const stats = await file.stat()
    if (!stats.isFile()) throw new Error(`文件预览只支持普通文件：${path}`)
    if (stats.size > CHECKPOINT_FILE_PREVIEW_MAX_BYTES) {
      return { kind: 'unavailable', reason: 'too-large', size: stats.size }
    }
    let buffer = Buffer.allocUnsafe(Math.min(stats.size, CHECKPOINT_FILE_PREVIEW_MAX_BYTES) + 1)
    let bytesRead = await readFromStart(file, buffer)
    if (
      bytesRead === buffer.length
      && buffer.length < CHECKPOINT_FILE_PREVIEW_MAX_BYTES + 1
    ) {
      buffer = Buffer.allocUnsafe(CHECKPOINT_FILE_PREVIEW_MAX_BYTES + 1)
      bytesRead = await readFromStart(file, buffer)
    }
    if (bytesRead > CHECKPOINT_FILE_PREVIEW_MAX_BYTES) {
      return { kind: 'unavailable', reason: 'too-large', size: bytesRead }
    }
    return decodeTextPreview(buffer.subarray(0, bytesRead))
  } finally {
    await file.close()
  }
}

async function readFromStart(file: FileHandle, buffer: Buffer): Promise<number> {
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return offset
}

function decodeTextPreview(content: Buffer): CheckpointFilePreviewState {
  if (content.includes(0)) {
    return { kind: 'unavailable', reason: 'binary', size: content.length }
  }
  try {
    return {
      kind: 'text',
      content: new TextDecoder('utf-8', { fatal: true }).decode(content),
      size: content.length,
    }
  } catch {
    return { kind: 'unavailable', reason: 'binary', size: content.length }
  }
}
