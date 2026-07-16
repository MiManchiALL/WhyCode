import { readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ImageAttachment } from './types.ts'
import type { PdfAttachment } from '../pdf/types.ts'
import { inlinePdfCacheStorageNames } from '../pdf/inline-cache.ts'

export interface SessionAttachmentReferences {
  imageAttachments: readonly ImageAttachment[]
  pdfAttachments: readonly PdfAttachment[]
}

/** 会话事实源加载完成后，统一清理全部 staging 目录与无引用附件。 */
export async function cleanupUnreferencedAttachments(
  attachmentDirectory: string,
  references: SessionAttachmentReferences,
): Promise<void> {
  const directory = resolve(attachmentDirectory)
  const allowed = new Set([
    ...references.imageAttachments.map((attachment) => attachment.storageName),
    ...references.pdfAttachments.map((attachment) => attachment.storageName),
    ...references.pdfAttachments.flatMap(inlinePdfCacheStorageNames),
  ])
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    },
  )

  await Promise.all(entries.flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && isAttachmentStagingDirectory(entry.name)) {
      return [rm(path, { recursive: true, force: true })]
    }
    if (entry.isFile() && !allowed.has(entry.name)) return [rm(path, { force: true })]
    return []
  }))
}

function isAttachmentStagingDirectory(name: string): boolean {
  return name.startsWith('.image-import-')
    || name.startsWith('.pdf-import-')
    || name.startsWith('.pdf-inline-')
}
