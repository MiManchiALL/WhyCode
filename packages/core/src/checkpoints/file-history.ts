import { localWorkspaceIO, type WorkspaceIO, type WorkspaceReader } from '../workspace/io.ts'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { link, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FileState } from './types.ts'
import {
  CHECKPOINT_FILE_PREVIEW_MAX_BYTES,
  type CheckpointFilePreviewState,
} from './types.ts'

async function collectMissingParents(path: string, io: WorkspaceIO): Promise<string[]> {
  const { dirname } = io.path
  const { lstat } = io.fs
  const missing: string[] = []
  let current = dirname(path)
  while (current !== dirname(current)) {
    if (await lstat(current).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })) break
    missing.push(current)
    current = dirname(current)
  }
  return missing
}

/** 捕获精确文件，不经过 .gitignore；因此敏感文件、二进制和项目外路径也可可靠回滚。 */
export async function captureFileState(path: string, blobDir: string, io: WorkspaceIO = localWorkspaceIO): Promise<FileState> {
  const absolute = io.path.resolve(path)
  const stats = await io.fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!stats) {
    return {
      path: absolute,
      kind: 'missing',
      missingParents: await collectMissingParents(absolute, io),
    }
  }
  if (!stats.isFile()) {
    throw new Error(`精确回滚只支持普通文件：${absolute}`)
  }
  await mkdir(blobDir, { recursive: true, mode: 0o700 })
  const temporary = join(blobDir, `${randomUUID()}.tmp`)
  const digest = createHash('sha256')
  let size = 0
  try {
    await pipeline(io.fs.createReadStream(absolute), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        digest.update(chunk)
        size += chunk.length
        callback(null, chunk)
      },
    }), createWriteStream(temporary, { flags: 'wx', mode: 0o600, flush: true }))
    const contentHash = digest.digest('hex')
    // 完整写入后才发布按内容寻址的 blob，另一个捕获者不会读到半份备份。
    await link(temporary, join(blobDir, contentHash)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    return {
      path: absolute, kind: 'file', contentHash, blobHash: contentHash,
      size, mode: stats.mode, missingParents: [],
    }
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function currentFileMatches(expected: FileState, io: WorkspaceIO = localWorkspaceIO): Promise<boolean> {
  const stats = await io.fs.lstat(expected.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (expected.kind === 'missing') return stats === null
  if (!stats?.isFile() || stats.size !== expected.size) return false
  return hashFile(expected.path, io).then(
    (currentHash) => currentHash === expected.contentHash,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    },
  )
}

/** 分块计算当前文件摘要，避免预览一致性检查把大文件整体读入内存。 */
async function hashFile(path: string, io: WorkspaceIO): Promise<string> {
  const file = await io.fs.open(path, 'r')
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

export async function restoreFileState(state: FileState, blobDir: string, io: WorkspaceIO = localWorkspaceIO): Promise<void> {
  const { rm, rmdir, mkdir, rename, chmod } = io.fs
  const { dirname } = io.path
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
  await mkdir(dirname(state.path), { recursive: true })
  const temp = `${state.path}.${process.pid}.${randomUUID()}.whycode-restore`
  try {
    await pipeline(createReadStream(join(blobDir, state.blobHash)),
      io.fs.createWriteStream(temp, { flags: 'wx', mode: state.mode ?? 0o600, flush: true }))
    // Windows rename 不覆盖已有目标；先移除已通过冲突预检的当前版本，再原子放入备份。
    if (io.platform === 'win32') await rm(state.path, { force: true })
    await rename(temp, state.path)
    if (state.mode !== undefined) await chmod(state.path, state.mode).catch(() => {})
  } finally {
    await rm(temp, { force: true })
  }
}

/** 预览只读取检查点已经拥有的精确 blob；大文件和二进制不进入 Renderer。 */
export async function readFileStatePreview(
  state: FileState,
  blobDir: string,
): Promise<CheckpointFilePreviewState> {
  if (state.kind === 'missing') return { kind: 'missing' }
  if (!state.blobHash) throw new Error(`文件备份缺少内容引用：${state.path}`)
  return readFileTextPreview(join(blobDir, state.blobHash))
}

/** 历史展示、审批与行数统计共用边界；不可预览不妨碍按字节备份或操作文件。 */
export async function readFileTextPreview(path: string, io: WorkspaceIO = localWorkspaceIO): Promise<CheckpointFilePreviewState> {
  const file = await io.fs.open(path, 'r')
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

async function readFromStart(file: WorkspaceReader, buffer: Buffer): Promise<number> {
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
