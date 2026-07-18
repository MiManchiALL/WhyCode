import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { LoadedSession } from './types.ts'
import type { SessionPaths } from './metadata.ts'

/**
 * 完整校验后的廉价磁盘身份。命中只复用本进程已经做过的解码、摘要与 PDF 解析；
 * transcript、附件集合或任一源文件变化都会失效并重新走完整校验。
 */
export async function attachmentValidationSignature(
  paths: SessionPaths,
  loaded: LoadedSession,
): Promise<string> {
  const entries = await readdir(paths.attachments, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    },
  )
  const sourceNames = [...new Set([
    ...loaded.imageAttachments.map((attachment) => attachment.storageName),
    ...loaded.pdfAttachments.map((attachment) => attachment.storageName),
  ])].sort()
  const sources: { name: string; identity: string }[] = []
  for (const name of sourceNames) {
    sources.push({ name, identity: await fileIdentity(join(paths.attachments, name)) })
  }
  const directoryEntries = entries
    .map((entry) => ({
      name: entry.name,
      type: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other',
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return JSON.stringify({
    transcript: await fileIdentity(paths.transcript),
    directoryEntries,
    sources,
  })
}

async function fileIdentity(path: string): Promise<string> {
  const value = await stat(path, { bigint: true })
  return [
    value.dev,
    value.ino,
    value.mode,
    value.size,
    value.mtimeNs,
    value.ctimeNs,
  ].join(':')
}
