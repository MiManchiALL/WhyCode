import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import {
  PDF_INLINE_VISUAL_MAX_BYTES,
  PDF_INLINE_VISUAL_MAX_PAGES,
  PDF_TEXT_MAX_CHARS,
} from './limits.ts'
import type { PdfProcessor } from './processor.ts'
import { pdfAttachmentPath } from './storage.ts'
import { pdfAttachmentSchema, type PdfAttachment } from './types.ts'

const CACHE_VERSION = 2
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const cachedPageSchema = z.object({
  pageNumber: z.number().int().positive(),
  text: z.string().max(PDF_TEXT_MAX_CHARS),
  textClipped: z.boolean(),
  storageName: z.string().regex(/^[0-9a-f-]+\.pdf-page-\d{4}\.png$/i),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteLength: z.number().int().positive().max(PDF_INLINE_VISUAL_MAX_BYTES),
})

const cacheManifestSchema = z.object({
  version: z.literal(CACHE_VERSION),
  attachmentId: z.string().uuid(),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  pageCount: z.number().int().positive().max(PDF_INLINE_VISUAL_MAX_PAGES),
  pages: z.array(cachedPageSchema).min(1).max(PDF_INLINE_VISUAL_MAX_PAGES),
})

type CacheManifest = z.infer<typeof cacheManifestSchema>

export interface InlinePdfPage {
  pageNumber: number
  text: string
  textClipped: boolean
  storageName: string
  bytes: Buffer
}

export function inlinePdfCacheStorageNames(attachment: PdfAttachment): string[] {
  const parsed = pdfAttachmentSchema.parse(attachment)
  if (parsed.pageCount > PDF_INLINE_VISUAL_MAX_PAGES) return []
  return [
    cacheManifestName(parsed.id),
    ...Array.from({ length: parsed.pageCount }, (_, index) =>
      cachePageName(parsed.id, index + 1)),
  ]
}

export async function loadInlinePdfPages(
  attachmentDirectory: string,
  attachment: PdfAttachment,
  processor: PdfProcessor,
  abortSignal: AbortSignal,
): Promise<InlinePdfPage[]> {
  const parsed = pdfAttachmentSchema.parse(attachment)
  if (parsed.pageCount > PDF_INLINE_VISUAL_MAX_PAGES) {
    throw new Error('PDF 超过自动视觉展开页数')
  }
  const cached = await readCache(attachmentDirectory, parsed, abortSignal)
  if (cached) return cached
  await removeCacheFiles(attachmentDirectory, parsed)
  await buildCache(attachmentDirectory, parsed, processor, abortSignal)
  const built = await readCache(attachmentDirectory, parsed, abortSignal)
  if (!built) throw new Error('PDF 页面缓存写入后校验失败')
  return built
}

async function buildCache(
  attachmentDirectory: string,
  attachment: PdfAttachment,
  processor: PdfProcessor,
  abortSignal: AbortSignal,
): Promise<void> {
  throwIfAborted(abortSignal)
  const directory = resolve(attachmentDirectory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const staging = join(directory, `.pdf-inline-${randomUUID()}`)
  await mkdir(staging, { mode: 0o700 })
  const committed: string[] = []
  try {
    const result = await processor.readPages(
      pdfAttachmentPath(directory, attachment.storageName),
      {
        startPage: 1,
        pageCount: attachment.pageCount,
        render: true,
        expectedSha256: attachment.sha256,
        outputDirectory: staging,
      },
      abortSignal,
    )
    if (
      result.pageCount !== attachment.pageCount
      || result.pages.length !== attachment.pageCount
      || result.renderedPages.length !== attachment.pageCount
    ) throw new Error('PDF 自动展开结果与附件页数不一致')

    const pages: CacheManifest['pages'] = []
    let totalBytes = 0
    for (let index = 0; index < attachment.pageCount; index++) {
      throwIfAborted(abortSignal)
      const textPage = result.pages[index]!
      const rendered = result.renderedPages[index]!
      if (textPage.pageNumber !== index + 1 || rendered.pageNumber !== index + 1) {
        throw new Error('PDF 自动展开页码不连续')
      }
      const bytes = await readFile(rendered.path)
      assertPng(bytes)
      totalBytes += bytes.byteLength
      if (totalBytes > PDF_INLINE_VISUAL_MAX_BYTES) {
        throw new Error('PDF 页面图超过自动展开字节预算')
      }
      pages.push({
        pageNumber: index + 1,
        text: textPage.text.slice(0, PDF_TEXT_MAX_CHARS),
        textClipped: textPage.text.length > PDF_TEXT_MAX_CHARS,
        storageName: cachePageName(attachment.id, index + 1),
        sha256: digest(bytes),
        byteLength: bytes.byteLength,
      })
    }
    const manifest = cacheManifestSchema.parse({
      version: CACHE_VERSION,
      attachmentId: attachment.id,
      sourceSha256: attachment.sha256,
      pageCount: attachment.pageCount,
      pages,
    })
    await writeFile(join(staging, cacheManifestName(attachment.id)), JSON.stringify(manifest), {
      encoding: 'utf-8', mode: 0o600, flag: 'wx',
    })
    for (const [index, page] of pages.entries()) {
      const source = result.renderedPages[index]!.path
      const target = join(directory, page.storageName)
      await rm(target, { force: true })
      await rename(source, target)
      committed.push(target)
    }
    const manifestTarget = join(directory, cacheManifestName(attachment.id))
    await rm(manifestTarget, { force: true })
    await rename(join(staging, cacheManifestName(attachment.id)), manifestTarget)
    committed.push(manifestTarget)
  } catch (error) {
    await Promise.all(committed.map((path) => rm(path, { force: true }).catch(() => {})))
    throw error
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

async function readCache(
  attachmentDirectory: string,
  attachment: PdfAttachment,
  abortSignal: AbortSignal,
): Promise<InlinePdfPage[] | null> {
  try {
    const directory = resolve(attachmentDirectory)
    const manifest = cacheManifestSchema.parse(JSON.parse(
      await readFile(join(directory, cacheManifestName(attachment.id)), 'utf-8'),
    ))
    if (
      manifest.attachmentId !== attachment.id
      || manifest.sourceSha256 !== attachment.sha256
      || manifest.pageCount !== attachment.pageCount
      || manifest.pages.length !== attachment.pageCount
    ) return null
    let totalBytes = 0
    const pages: InlinePdfPage[] = []
    for (const [index, page] of manifest.pages.entries()) {
      throwIfAborted(abortSignal)
      if (page.pageNumber !== index + 1 || page.storageName !== cachePageName(attachment.id, index + 1)) {
        return null
      }
      const bytes = await readFile(join(directory, page.storageName))
      assertPng(bytes)
      totalBytes += bytes.byteLength
      if (
        bytes.byteLength !== page.byteLength
        || digest(bytes) !== page.sha256
        || totalBytes > PDF_INLINE_VISUAL_MAX_BYTES
      ) return null
      pages.push({
        pageNumber: page.pageNumber,
        text: page.text,
        textClipped: page.textClipped,
        storageName: page.storageName,
        bytes,
      })
    }
    return pages
  } catch (error) {
    if (abortSignal.aborted) throw error
    return null
  }
}

async function removeCacheFiles(directory: string, attachment: PdfAttachment): Promise<void> {
  await Promise.all(inlinePdfCacheStorageNames(attachment).map((name) =>
    rm(join(resolve(directory), name), { force: true }).catch(() => {})))
}

function cacheManifestName(attachmentId: string): string {
  return `${attachmentId}.pdf-inline.json`
}

function cachePageName(attachmentId: string, pageNumber: number): string {
  return `${attachmentId}.pdf-page-${String(pageNumber).padStart(4, '0')}.png`
}

function assertPng(bytes: Buffer): void {
  if (bytes.byteLength < PNG_SIGNATURE.byteLength || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('PDF 页面渲染结果不是有效 PNG')
  }
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('PDF 自动展开已取消')
}
