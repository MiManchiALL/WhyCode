import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  OFFICE_ARTIFACT_MAX_SOURCE_BYTES,
  OfficeProcessingError,
} from '@whycode/core/office'

export async function publishVerifiedFile(
  source: string,
  target: string,
  expectedSha256: string,
): Promise<void> {
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new OfficeProcessingError('unsupported', `Office 输出目标不是普通文件：${target}`)
  }
  await mkdir(dirname(target), { recursive: true })
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.whycode-office`)
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL)
    const temporaryFile = await open(temporary, 'r+')
    try {
      await temporaryFile.sync()
    } finally {
      await temporaryFile.close()
    }
    const verification = await hashFile(temporary)
    if (
      verification.sha256 !== expectedSha256
      || verification.byteLength <= 0
      || verification.byteLength > OFFICE_ARTIFACT_MAX_SOURCE_BYTES
    ) {
      throw new OfficeProcessingError('corrupted', 'Office 发布前哈希校验失败')
    }
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  const published = await hashFile(target)
  if (published.sha256 !== expectedSha256) {
    throw new OfficeProcessingError('corrupted', 'Office 发布后哈希校验失败')
  }
}

async function hashFile(path: string): Promise<{ byteLength: number; sha256: string }> {
  const file = await open(path, 'r')
  const hash = createHash('sha256')
  let byteLength = 0
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    while (true) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null)
      if (bytesRead === 0) break
      byteLength += bytesRead
      if (byteLength > OFFICE_ARTIFACT_MAX_SOURCE_BYTES) {
        throw new OfficeProcessingError('too-large', 'Office 文件超过 100 MB 上限')
      }
      hash.update(chunk.subarray(0, bytesRead))
    }
  } finally {
    await file.close()
  }
  return { byteLength, sha256: hash.digest('hex') }
}
