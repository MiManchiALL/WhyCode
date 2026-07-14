import { mkdir, readdir, rename, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readBoundedImageFile } from './storage.ts'
import { IMAGE_MODEL_MAX_BYTES, type ImageAttachment } from './types.ts'

const RENDITION_DIRECTORY = '.model-renditions'
const RENDITION_VERSION = 'v2'
const MAX_RENDITION_CACHE_BYTES = 64 * 1024 * 1024
const STALE_TEMP_MILLISECONDS = 60 * 60 * 1_000
const DIGEST_PATTERN = /^[0-9a-f]{64}$/

export async function readRenditionCache(
  attachmentDirectory: string,
  attachment: ImageAttachment,
  sourceDigest: string,
): Promise<Buffer | null> {
  const path = renditionPath(attachmentDirectory, attachment.id, sourceDigest)
  try {
    const bytes = await readBoundedImageFile(path, IMAGE_MODEL_MAX_BYTES)
    const now = new Date()
    await utimes(path, now, now).catch(() => {})
    return bytes
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    await rm(path, { force: true }).catch(() => {})
    return null
  }
}

export async function writeRenditionCache(
  attachmentDirectory: string,
  attachment: ImageAttachment,
  sourceDigest: string,
  bytes: Buffer,
): Promise<void> {
  const directory = renditionDirectory(attachmentDirectory)
  const target = renditionPath(attachmentDirectory, attachment.id, sourceDigest)
  const temporary = join(directory, `${attachment.id}.${randomUUID()}.tmp`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600, flush: true })
  try {
    await rename(temporary, target).catch(async (error) => {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(errorCode(error) ?? '')) throw error
      try {
        const existing = await stat(target)
        if (!existing.isFile()) throw error
      } catch (targetError) {
        if (errorCode(targetError) === 'ENOENT') throw error
        throw targetError
      }
    })
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
  await enforceRenditionCacheBudget(directory)
}

export async function removeRenditionCacheEntry(
  attachmentDirectory: string,
  attachmentId: string,
  sourceDigest: string,
): Promise<void> {
  await rm(renditionPath(attachmentDirectory, attachmentId, sourceDigest), { force: true })
}

export async function removeRenditionCaches(
  attachmentDirectory: string,
  attachments: readonly ImageAttachment[],
): Promise<void> {
  const directory = renditionDirectory(attachmentDirectory)
  const ids = new Set(attachments.map((attachment) => attachment.id.toLowerCase()))
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw error
  }
  await Promise.all(names.flatMap((name) => {
    const id = name.slice(0, 36).toLowerCase()
    return ids.has(id) && name[36] === '.'
      ? [rm(join(directory, name), { force: true })]
      : []
  }))
  await rmdir(directory).catch((error) => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'].includes(errorCode(error) ?? '')) {
      throw error
    }
  })
}

async function enforceRenditionCacheBudget(directory: string): Promise<void> {
  const names = await readdir(directory)
  await removeSupersededEntries(directory, names)
  const entries = (await Promise.all(names.flatMap((name) =>
    isCacheName(name)
      ? [stat(join(directory, name))
          .then((value) => ({ name, ...value }))
          .catch((error) => errorCode(error) === 'ENOENT' ? null : Promise.reject(error))]
      : []))).filter((entry) => entry !== null)
  let total = entries.reduce((sum, entry) => sum + entry.size, 0)
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs)
  for (const entry of entries) {
    if (total <= MAX_RENDITION_CACHE_BYTES) break
    await rm(join(directory, entry.name), { force: true })
    total -= entry.size
  }
}

async function removeSupersededEntries(directory: string, names: readonly string[]): Promise<void> {
  const staleBefore = Date.now() - STALE_TEMP_MILLISECONDS
  await Promise.all(names.flatMap((name) => {
    const path = join(directory, name)
    if (isOldCacheName(name)) return [rm(path, { force: true })]
    if (!isTemporaryName(name)) return []
    return [stat(path)
      .then((value) => value.mtimeMs < staleBefore ? rm(path, { force: true }) : undefined)
      .catch((error) => {
        if (errorCode(error) !== 'ENOENT') throw error
      })]
  }))
}

function renditionDirectory(attachmentDirectory: string): string {
  return join(resolve(attachmentDirectory), RENDITION_DIRECTORY)
}

function renditionPath(
  attachmentDirectory: string,
  attachmentId: string,
  sourceDigest: string,
): string {
  if (!DIGEST_PATTERN.test(sourceDigest)) throw new Error('图片内容摘要无效')
  return join(
    renditionDirectory(attachmentDirectory),
    `${attachmentId}.${sourceDigest}.${RENDITION_VERSION}`,
  )
}

function isCacheName(name: string): boolean {
  return /^[0-9a-f-]{36}\.[0-9a-f]{64}\.v2$/i.test(name)
}

function isOldCacheName(name: string): boolean {
  return /^[0-9a-f-]{36}\.v1$/i.test(name)
}

function isTemporaryName(name: string): boolean {
  return /^[0-9a-f-]{36}\.[0-9a-f-]{36}\.tmp$/i.test(name)
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined
}
