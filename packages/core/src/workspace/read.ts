import { localWorkspaceIO, type WorkspaceIO } from './io.ts'

const READ_CHUNK_BYTES = 64 * 1024
const READ_CONCURRENCY = 8

/** 按打开的文件身份限量读取；远端短读与读取期间增长都不能突破预算。 */
export async function readBoundedWorkspaceFile(
  path: string,
  maxBytes: number,
  io: WorkspaceIO = localWorkspaceIO,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted()
  const file = await io.fs.open(path, 'r')
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new Error(`路径必须指向普通文件：${path}`)
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > maxBytes) {
      throw new Error(`文件超过 ${maxBytes} 字节上限：${path}`)
    }
    const bytes = Buffer.alloc(metadata.size)
    for (let start = 0; start < bytes.byteLength; start += READ_CHUNK_BYTES * READ_CONCURRENCY) {
      signal?.throwIfAborted()
      const count = Math.min(READ_CONCURRENCY, Math.ceil((bytes.byteLength - start) / READ_CHUNK_BYTES))
      // 位置读取互不重叠；等整批结束再关闭句柄，避免失败时遗留在途读取。
      const results = await Promise.allSettled(Array.from({ length: count }, async (_, index) => {
        let offset = start + index * READ_CHUNK_BYTES
        const end = Math.min(bytes.byteLength, offset + READ_CHUNK_BYTES)
        while (offset < end) {
          signal?.throwIfAborted()
          const { bytesRead } = await file.read(bytes, offset, end - offset, offset)
          if (bytesRead === 0) throw new Error(`读取时文件发生变化：${path}`)
          offset += bytesRead
        }
      }))
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
    signal?.throwIfAborted()
    if ((await file.read(Buffer.alloc(1), 0, 1, metadata.size)).bytesRead) {
      throw new Error(`读取时文件发生变化：${path}`)
    }
    return bytes
  } finally {
    await file.close()
  }
}
