import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  removeRenditionCaches,
  writeRenditionCache,
} from './rendition-cache.ts'
import type { ImageAttachment } from './types.ts'

const DIGEST = 'a'.repeat(64)
const MAX_CACHE_BYTES = 64 * 1024 * 1024

describe('图片衍生图缓存', () => {
  it('同一内容的并发写入保持原子性且不遗留临时文件', async () => {
    await withTempDirectory(async (directory) => {
      const attachment = imageAttachment(1)
      const candidates = Array.from({ length: 8 }, (_, index) =>
        Buffer.alloc(1_024, index + 1))

      await Promise.all(candidates.map((bytes) =>
        writeRenditionCache(directory, attachment, DIGEST, bytes)))

      const names = await readdir(join(directory, '.model-renditions'))
      assert.equal(names.filter((name) => name.endsWith('.v3')).length, 1)
      assert.equal(names.some((name) => name.endsWith('.tmp')), false)
      const stored = await readFile(join(directory, '.model-renditions', names[0]!))
      assert.equal(candidates.some((candidate) => candidate.equals(stored)), true)
    })
  })

  it('按会话限制缓存总量，并在回收最后一项后删除空目录', async () => {
    await withTempDirectory(async (directory) => {
      const attachments = Array.from({ length: 19 }, (_, index) => imageAttachment(index + 1))
      const rendition = Buffer.alloc(3_700_000, 7)
      for (const attachment of attachments) {
        await writeRenditionCache(directory, attachment, DIGEST, rendition)
      }

      const cacheDirectory = join(directory, '.model-renditions')
      const names = await readdir(cacheDirectory)
      const sizes = await Promise.all(names.map(async (name) =>
        (await stat(join(cacheDirectory, name))).size))
      assert.ok(sizes.reduce((total, size) => total + size, 0) <= MAX_CACHE_BYTES)
      assert.ok(names.length < attachments.length)

      await removeRenditionCaches(directory, attachments)
      assert.deepEqual(await readdir(directory), [])
    })
  })

  it('只清理过期临时文件，不干扰可能仍在写入的新文件', async () => {
    await withTempDirectory(async (directory) => {
      const cacheDirectory = join(directory, '.model-renditions')
      await mkdir(cacheDirectory, { recursive: true })
      const fresh = `${imageAttachment(1).id}.11111111-1111-4111-8111-111111111111.tmp`
      const stale = `${imageAttachment(2).id}.22222222-2222-4222-8222-222222222222.tmp`
      await Promise.all([
        writeFile(join(cacheDirectory, fresh), 'active'),
        writeFile(join(cacheDirectory, stale), 'stale'),
      ])
      await utimes(join(cacheDirectory, stale), new Date(0), new Date(0))

      await writeRenditionCache(directory, imageAttachment(3), DIGEST, Buffer.from('cache'))
      const names = await readdir(cacheDirectory)
      assert.equal(names.includes(fresh), true)
      assert.equal(names.includes(stale), false)
    })
  })
})

function imageAttachment(index: number): ImageAttachment {
  const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  return {
    id,
    sessionId: '11111111-1111-4111-8111-111111111111',
    name: `${index}.png`,
    storageName: `${id}.png`,
    mediaType: 'image/png',
    sha256: DIGEST,
    byteLength: 1,
    width: 1,
    height: 1,
  }
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'whycode-rendition-cache-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
