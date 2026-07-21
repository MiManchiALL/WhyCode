import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import {
  PDF_ATTACHMENT_MAX_COUNT,
  PDF_ATTACHMENT_MAX_SOURCE_BYTES,
  PDF_ATTACHMENT_MAX_TOTAL_BYTES,
  pdfAttachmentSchema,
  pdfAttachmentStorageNameSchema,
  type PdfAttachment,
  type PdfAttachmentInput,
} from './types.ts'
import { PdfProcessingError, type PdfProcessor } from './processor.ts'

const COPY_BUFFER_BYTES = 64 * 1_024

export interface PdfAttachmentImportTransaction {
  readonly attachments: readonly PdfAttachment[]
  commit(): Promise<void>
  rollback(): Promise<void>
}

/** 字节来源只供 Main 内部已完成有界下载的 PDF 使用，不进入 Renderer IPC。 */
export type PdfAttachmentImportSource =
  | PdfAttachmentInput
  | { kind: 'bytes'; bytes: Uint8Array; name: string }

export async function preparePdfAttachmentImport(
  sources: readonly PdfAttachmentImportSource[],
  attachmentDirectory: string,
  sessionId: string,
  processor: PdfProcessor,
  abortSignal: AbortSignal,
): Promise<PdfAttachmentImportTransaction> {
  if (sources.length === 0) return emptyTransaction()
  if (sources.length > PDF_ATTACHMENT_MAX_COUNT) {
    throw new Error(`每条消息最多添加 ${PDF_ATTACHMENT_MAX_COUNT} 个 PDF`)
  }
  const normalizedPaths = sources.flatMap((source) =>
    source.kind === 'path' ? [normalizeLocalPath(source.path)] : [])
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    throw new Error('同一个 PDF 不能重复添加')
  }

  const directory = resolve(attachmentDirectory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stagingDirectory = join(directory, `.pdf-import-${randomUUID()}`)
  await mkdir(stagingDirectory, { mode: 0o700 })
  const attachments: PdfAttachment[] = []
  const seenDigests = new Set<string>()
  let totalBytes = 0

  try {
    for (const source of sources) {
      throwIfAborted(abortSignal)
      const id = randomUUID()
      const storageName = `${id}.pdf`
      const stagedPath = join(stagingDirectory, storageName)
      const copied = source.kind === 'path'
        ? await copyPdfFile(source.path, stagedPath, abortSignal)
        : await writePdfBytes(source.bytes, stagedPath, abortSignal)
      totalBytes += copied.byteLength
      if (totalBytes > PDF_ATTACHMENT_MAX_TOTAL_BYTES) {
        throw new Error('PDF 附件总大小超过 100 MB 上限')
      }
      if (seenDigests.has(copied.sha256)) throw new Error('同一个 PDF 不能重复添加')
      seenDigests.add(copied.sha256)

      const inspected = await processor.inspect(stagedPath, abortSignal)
      if (inspected.byteLength !== copied.byteLength) {
        const displayName = safeDisplayName(source.kind === 'path' ? source.path : source.name)
        throw new Error(`PDF 检查结果与磁盘文件不一致：${displayName}`)
      }
      attachments.push(pdfAttachmentSchema.parse({
        id,
        sessionId,
        name: safeDisplayName(source.kind === 'path' ? source.path : source.name),
        storageName,
        mediaType: 'application/pdf',
        sha256: copied.sha256,
        byteLength: copied.byteLength,
        pageCount: inspected.pageCount,
      }))
    }
    return createImportTransaction(directory, stagingDirectory, attachments)
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/** 恢复会话时重新校验归属、字节摘要与 PDF 引擎解析结果。 */
export async function validateStoredPdfAttachments(
  attachmentDirectory: string,
  sessionId: string,
  attachments: readonly PdfAttachment[],
  processor: PdfProcessor,
  abortSignal: AbortSignal,
): Promise<void> {
  const unique = new Map<string, { serialized: string; attachment: PdfAttachment }>()
  for (const attachment of attachments) {
    if (attachment.sessionId !== sessionId) throw new Error('PDF 附件不属于当前会话')
    const serialized = JSON.stringify(attachment)
    const previous = unique.get(attachment.storageName)
    if (previous && previous.serialized !== serialized) {
      throw new Error(`同一 PDF 附件存在冲突元数据：${attachment.storageName}`)
    }
    if (!previous) unique.set(attachment.storageName, { serialized, attachment })
  }

  for (const { attachment } of unique.values()) {
    throwIfAborted(abortSignal)
    const parsed = pdfAttachmentSchema.parse(attachment)
    const path = pdfAttachmentPath(attachmentDirectory, parsed.storageName)
    const file = await hashPdfFile(path, abortSignal)
    const inspected = await processor.inspect(path, abortSignal)
    if (
      file.byteLength !== parsed.byteLength
      || file.sha256 !== parsed.sha256
      || inspected.byteLength !== parsed.byteLength
      || inspected.pageCount !== parsed.pageCount
    ) {
      throw new Error(`PDF 附件元数据与磁盘文件不一致：${parsed.storageName}`)
    }
  }
}

export function pdfAttachmentPath(attachmentDirectory: string, storageName: string): string {
  const safeName = pdfAttachmentStorageNameSchema.parse(storageName)
  return join(resolve(attachmentDirectory), safeName)
}

export async function removePdfAttachmentFiles(
  attachmentDirectory: string,
  attachments: readonly PdfAttachment[],
): Promise<void> {
  await removePaths(attachments.map((attachment) =>
    pdfAttachmentPath(attachmentDirectory, attachment.storageName)))
}

function createImportTransaction(
  directory: string,
  stagingDirectory: string,
  attachments: PdfAttachment[],
): PdfAttachmentImportTransaction {
  let state: 'prepared' | 'committed' | 'rolled-back' = 'prepared'
  const committedPaths: string[] = []
  return {
    attachments,
    async commit() {
      if (state === 'committed') return
      if (state === 'rolled-back') throw new Error('PDF 导入事务已回滚')
      try {
        for (const attachment of attachments) {
          const target = pdfAttachmentPath(directory, attachment.storageName)
          await rename(join(stagingDirectory, attachment.storageName), target)
          committedPaths.push(target)
        }
        await rm(stagingDirectory, { recursive: true, force: true })
        state = 'committed'
      } catch (error) {
        await removePaths(committedPaths)
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
        state = 'rolled-back'
        throw error
      }
    },
    async rollback() {
      if (state === 'rolled-back') return
      await removePaths(committedPaths)
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
      state = 'rolled-back'
    },
  }
}

async function copyPdfFile(
  sourcePath: string,
  targetPath: string,
  abortSignal: AbortSignal,
): Promise<{ byteLength: number; sha256: string }> {
  const source = await open(resolve(sourcePath), 'r').catch((error) => {
    throw new PdfProcessingError('unavailable', `无法读取 PDF：${basename(sourcePath)}`, {
      cause: error,
    })
  })
  const target = await open(targetPath, 'wx', 0o600).catch(async (error) => {
    await source.close().catch(() => {})
    throw error
  })
  const hash = createHash('sha256')
  let byteLength = 0
  try {
    const info = await source.stat()
    if (!info.isFile()) throw new PdfProcessingError('corrupted', 'PDF 来源不是普通文件')
    if (info.size <= 0) throw new PdfProcessingError('empty', 'PDF 文件为空')
    if (info.size > PDF_ATTACHMENT_MAX_SOURCE_BYTES) {
      throw new PdfProcessingError('too-large', 'PDF 文件超过 50 MB 上限')
    }
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
    while (true) {
      throwIfAborted(abortSignal)
      const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      byteLength += bytesRead
      if (byteLength > PDF_ATTACHMENT_MAX_SOURCE_BYTES) {
        throw new PdfProcessingError('too-large', 'PDF 文件超过 50 MB 上限')
      }
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      await writeFully(target, chunk)
    }
    if (byteLength === 0) throw new PdfProcessingError('empty', 'PDF 文件为空')
    await target.sync()
    return { byteLength, sha256: hash.digest('hex') }
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => {})
    throw error
  } finally {
    await Promise.all([source.close(), target.close()])
  }
}

async function writePdfBytes(
  bytes: Uint8Array,
  targetPath: string,
  abortSignal: AbortSignal,
): Promise<{ byteLength: number; sha256: string }> {
  throwIfAborted(abortSignal)
  if (bytes.byteLength === 0) throw new PdfProcessingError('empty', 'PDF 文件为空')
  if (bytes.byteLength > PDF_ATTACHMENT_MAX_SOURCE_BYTES) {
    throw new PdfProcessingError('too-large', 'PDF 文件超过 50 MB 上限')
  }
  const target = await open(targetPath, 'wx', 0o600)
  try {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    await writeFully(target, buffer)
    await target.sync()
    throwIfAborted(abortSignal)
    return {
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    }
  } catch (error) {
    await rm(targetPath, { force: true }).catch(() => {})
    throw error
  } finally {
    await target.close()
  }
}

async function hashPdfFile(
  path: string,
  abortSignal: AbortSignal,
): Promise<{ byteLength: number; sha256: string }> {
  const file = await open(path, 'r')
  const hash = createHash('sha256')
  let byteLength = 0
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size <= 0 || info.size > PDF_ATTACHMENT_MAX_SOURCE_BYTES) {
      throw new Error(`PDF 附件磁盘文件无效：${basename(path)}`)
    }
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
    while (true) {
      throwIfAborted(abortSignal)
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      byteLength += bytesRead
      if (byteLength > PDF_ATTACHMENT_MAX_SOURCE_BYTES) {
        throw new Error(`PDF 附件磁盘文件超过大小上限：${basename(path)}`)
      }
      hash.update(buffer.subarray(0, bytesRead))
    }
    return { byteLength, sha256: hash.digest('hex') }
  } finally {
    await file.close()
  }
}

async function writeFully(file: Awaited<ReturnType<typeof open>>, bytes: Buffer): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset, null)
    if (bytesWritten === 0) throw new Error('写入 PDF 附件时磁盘没有进展')
    offset += bytesWritten
  }
}

function throwIfAborted(abortSignal: AbortSignal): void {
  if (abortSignal.aborted) throw new PdfProcessingError('aborted', 'PDF 处理已取消')
}

function emptyTransaction(): PdfAttachmentImportTransaction {
  return { attachments: [], commit: async () => {}, rollback: async () => {} }
}

function safeDisplayName(path: string): string {
  const cleaned = basename(path).replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'document.pdf'
  return cleaned.slice(0, 255)
}

function normalizeLocalPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function removePaths(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true }).catch(() => {})))
}
