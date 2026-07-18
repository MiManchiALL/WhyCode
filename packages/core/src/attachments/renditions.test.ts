import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import sharp from 'sharp'
import {
  createImageUserMessage,
  messagesForModel,
} from './messages.ts'
import { attachImagesToToolResults } from './tool-results.ts'
import { prepareImageAttachmentForModel } from './renditions.ts'
import { importImageAttachments, inspectImage } from './storage.ts'
import {
  IMAGE_ATTACHMENT_MAX_SOURCE_BYTES,
  IMAGE_MODEL_MAX_BYTES,
  IMAGE_MODEL_MAX_DIMENSION,
} from './types.ts'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'

describe('图片模型衍生图', () => {
  it('保留原图并缓存最长边受限的模型副本', async () => {
    await withTempDirectory(async (directory) => {
      const sourcePath = join(directory, 'wide.jpg')
      const attachmentDirectory = join(directory, 'attachments')
      const source = await sharp({
        create: { width: 3_000, height: 1_200, channels: 3, background: '#d946ef' },
      }).jpeg({ quality: 96 }).toBuffer()
      await writeFile(sourcePath, source)
      const [attachment] = await importImageAttachments(
        [{ kind: 'path', path: sourcePath }],
        attachmentDirectory,
        SESSION_ID,
      )
      assert.ok(attachment)

      const prepared = await prepareImageAttachmentForModel(attachmentDirectory, attachment)
      assert.equal(prepared.optimized, true)
      assert.ok(Math.max(prepared.width, prepared.height) <= IMAGE_MODEL_MAX_DIMENSION)
      assert.ok(prepared.bytes.byteLength <= IMAGE_MODEL_MAX_BYTES)
      assert.deepEqual(
        await readFile(join(attachmentDirectory, attachment.storageName)),
        source,
      )
      const cacheDirectory = join(attachmentDirectory, '.model-renditions')
      const [cacheName] = await readdir(cacheDirectory)
      assert.ok(cacheName)

      const cached = await prepareImageAttachmentForModel(attachmentDirectory, attachment)
      assert.deepEqual(cached, prepared)

      const cachePath = join(cacheDirectory, cacheName)
      const cacheBytes = await readFile(cachePath)
      const truncated = cacheBytes.subarray(0, Math.floor(cacheBytes.byteLength / 2))
      assert.doesNotThrow(() => inspectImage(truncated))
      await writeFile(cachePath, truncated)
      const regenerated = await prepareImageAttachmentForModel(attachmentDirectory, attachment)
      assert.deepEqual(regenerated, prepared)
      assert.deepEqual(await readFile(cachePath), prepared.bytes)

      const [request] = await messagesForModel(
        [createImageUserMessage('查看宽图', [attachment])],
        true,
        attachmentDirectory,
        [attachment],
      )
      assert.ok(request && typeof request.content !== 'string')
      const file = request.content.find((part) => part.type === 'file')
      assert.ok(file && typeof file.data === 'string')
      const info = inspectImage(Buffer.from(file.data, 'base64'))
      assert.equal(info.width, prepared.width)
      assert.equal(info.height, prepared.height)
      assert.equal(file.mediaType, prepared.mediaType)

      // 缓存只是可再生副本，不能在权威原图缺失时继续向模型提供旧内容。
      await rm(join(attachmentDirectory, attachment.storageName))
      await assert.rejects(
        prepareImageAttachmentForModel(attachmentDirectory, attachment),
      )
    })
  })

  it('接受大于模型边界的安全原图，并在请求前压缩到模型边界', async () => {
    await withTempDirectory(async (directory) => {
      const sourcePath = join(directory, 'large-source.png')
      const attachmentDirectory = join(directory, 'attachments')
      const pixels = randomBytes(1_300 * 1_300 * 3)
      const source = await sharp(pixels, {
        raw: { width: 1_300, height: 1_300, channels: 3 },
      }).png({ compressionLevel: 0 }).toBuffer()
      assert.ok(source.byteLength > IMAGE_MODEL_MAX_BYTES)
      assert.ok(source.byteLength < IMAGE_ATTACHMENT_MAX_SOURCE_BYTES)
      await writeFile(sourcePath, source)

      const [attachment] = await importImageAttachments(
        [{ kind: 'path', path: sourcePath }],
        attachmentDirectory,
        SESSION_ID,
      )
      assert.ok(attachment)
      assert.equal(attachment.byteLength, source.byteLength)

      const prepared = await prepareImageAttachmentForModel(attachmentDirectory, attachment)
      assert.equal(prepared.optimized, true)
      assert.ok(prepared.bytes.byteLength <= IMAGE_MODEL_MAX_BYTES)
      assert.ok(Math.max(prepared.width, prepared.height) <= IMAGE_MODEL_MAX_DIMENSION)
      assert.deepEqual(await readFile(join(attachmentDirectory, attachment.storageName)), source)
    })
  })

  it('在模型副本中纠正 EXIF 方向，不改写会话原图', async () => {
    await withTempDirectory(async (directory) => {
      const sourcePath = join(directory, 'rotated.jpg')
      const attachmentDirectory = join(directory, 'attachments')
      const source = await sharp({
        create: { width: 40, height: 20, channels: 3, background: '#2563eb' },
      }).jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer()
      await writeFile(sourcePath, source)
      const [attachment] = await importImageAttachments(
        [{ kind: 'path', path: sourcePath }],
        attachmentDirectory,
        SESSION_ID,
      )
      assert.ok(attachment)
      assert.deepEqual([attachment.width, attachment.height], [40, 20])

      const prepared = await prepareImageAttachmentForModel(attachmentDirectory, attachment)
      assert.equal(prepared.optimized, true)
      assert.deepEqual([prepared.width, prepared.height], [20, 40])
      assert.deepEqual(await readFile(join(attachmentDirectory, attachment.storageName)), source)
    })
  })

  it('high、original 与 region 使用独立缓存并返回可逆像素映射', async () => {
    await withTempDirectory(async (directory) => {
      const sourcePath = join(directory, 'details.png')
      const attachmentDirectory = join(directory, 'attachments')
      const source = await sharp({
        create: { width: 3_000, height: 1_400, channels: 3, background: '#16a34a' },
      }).png().toBuffer()
      await writeFile(sourcePath, source)
      const [attachment] = await importImageAttachments(
        [{ kind: 'path', path: sourcePath }],
        attachmentDirectory,
        SESSION_ID,
      )
      assert.ok(attachment)
      const region = { x: 200, y: 100, width: 2_500, height: 1_000 }

      const high = await prepareImageAttachmentForModel(
        attachmentDirectory,
        attachment,
        undefined,
        { detail: 'high', region },
      )
      const original = await prepareImageAttachmentForModel(
        attachmentDirectory,
        attachment,
        undefined,
        { detail: 'original', region },
      )
      assert.deepEqual([high.width, high.height], [2_048, 819])
      assert.deepEqual([original.width, original.height], [2_500, 1_000])
      assert.deepEqual(original.selectedRegion, region)
      assert.equal(original.modelToSourceScaleX, 1)
      assert.equal(original.modelToSourceScaleY, 1)
      assert.equal(Number(high.modelToSourceScaleX.toFixed(6)), Number((2_500 / 2_048).toFixed(6)))

      const cacheNames = await readdir(join(attachmentDirectory, '.model-renditions'))
      assert.equal(cacheNames.filter((name) => name.endsWith('.v3')).length, 2)
      const [request] = await messagesForModel(
        attachImagesToToolResults([toolResultMessage()], [{
          toolCallId: 'view-image-1',
          attachments: [attachment],
          transform: { detail: 'original', region },
        }]),
        true,
        attachmentDirectory,
        [attachment],
      )
      assert.ok(request?.role === 'tool')
      const result = request.content.find((part) => part.type === 'tool-result')
      assert.ok(result?.type === 'tool-result' && result.output.type === 'content')
      const file = result.output.value.find((part) => part.type === 'file')
      assert.ok(file?.type === 'file' && file.data.type === 'data')
      assert.equal(typeof file.data.data, 'string')
      assert.deepEqual(
        [
          inspectImage(Buffer.from(file.data.data as string, 'base64')).width,
          inspectImage(Buffer.from(file.data.data as string, 'base64')).height,
        ],
        [2_500, 1_000],
      )

      await assert.rejects(
        prepareImageAttachmentForModel(
          attachmentDirectory,
          attachment,
          undefined,
          { detail: 'high', region: { x: 2_900, y: 0, width: 200, height: 100 } },
        ),
        /超出.*源图边界/,
      )
    })
  })
})

function toolResultMessage() {
  return {
    role: 'tool' as const,
    content: [{
      type: 'tool-result' as const,
      toolCallId: 'view-image-1',
      toolName: 'ViewImage',
      output: { type: 'text' as const, value: '已读取图片。' },
    }],
  }
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'whycode-renditions-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
