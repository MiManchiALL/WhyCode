import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { modelMessageSchema } from 'ai'
import sharp from 'sharp'
import {
  createImageUserMessage,
  dehydrateImageMessages,
  messagesForModel,
} from './messages.ts'
import {
  importImageAttachments,
  inspectImage,
  validateStoredImageAttachments,
} from './storage.ts'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)
const SESSION_ID = '11111111-1111-4111-8111-111111111111'

describe('图片附件', () => {
  it('从 PNG、JPEG 与 WebP 头部读取真实媒体类型和尺寸', () => {
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x30,
      0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    ])
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'ascii')
    webp.write('WEBP', 8, 'ascii')
    webp.write('VP8X', 12, 'ascii')
    webp.writeUIntLE(47, 24, 3)
    webp.writeUIntLE(31, 27, 3)

    assert.deepEqual(inspectImage(ONE_PIXEL_PNG), {
      mediaType: 'image/png', extension: 'png', width: 1, height: 1,
    })
    assert.deepEqual(inspectImage(jpeg), {
      mediaType: 'image/jpeg', extension: 'jpg', width: 48, height: 32,
    })
    assert.deepEqual(inspectImage(webp), {
      mediaType: 'image/webp', extension: 'webp', width: 48, height: 32,
    })
  })

  it('按真实字节识别格式，并以会话内不可变文件保存', async () => {
    await withTempDirectory(async (directory) => {
      const source = join(directory, '截图.txt')
      const attachments = join(directory, 'attachments')
      await writeFile(source, ONE_PIXEL_PNG)

      const [attachment] = await importImageAttachments(
        [{ kind: 'path', path: source }], attachments, SESSION_ID,
      )
      assert.ok(attachment)
      assert.equal(attachment.mediaType, 'image/png')
      assert.equal(attachment.width, 1)
      assert.equal(attachment.height, 1)
      assert.match(attachment.sha256 ?? '', /^[0-9a-f]{64}$/)
      assert.match(attachment.storageName, /\.png$/)
      assert.deepEqual(
        await readFile(join(attachments, attachment.storageName)),
        ONE_PIXEL_PNG,
      )
    })
  })

  it('完整解码 PNG、JPEG 与 WebP，拒绝只有合法文件头的截断图片', async () => {
    await withTempDirectory(async (directory) => {
      for (const format of ['png', 'jpeg', 'webp'] as const) {
        const valid = await noisyImage(format)
        const truncated = valid.subarray(0, Math.floor(valid.byteLength / 2))
        assert.doesNotThrow(() => inspectImage(truncated))
        const target = join(directory, format)

        await assert.rejects(
          importImageAttachments([{
            kind: 'inline',
            name: `truncated.${format}`,
            base64: truncated.toString('base64'),
          }], target, SESSION_ID),
          /无法完整解码/,
        )
        assert.deepEqual(await readdir(target), [])
      }
    })
  })

  it('恢复会话时用内容摘要识别尺寸与字节数相同的图片替换', async () => {
    await withTempDirectory(async (directory) => {
      const attachmentDirectory = join(directory, 'attachments')
      const red = await solidPng('#ef4444')
      const blue = await solidPng('#3b82f6')
      assert.equal(red.byteLength, blue.byteLength)
      const [attachment] = await importImageAttachments([{
        kind: 'inline', name: 'solid.png', base64: red.toString('base64'),
      }], attachmentDirectory, SESSION_ID)
      assert.ok(attachment)

      await writeFile(join(attachmentDirectory, attachment.storageName), blue)
      await assert.rejects(
        validateStoredImageAttachments(attachmentDirectory, SESSION_ID, [attachment]),
        /元数据与磁盘文件不一致/,
      )
    })
  })

  it('图片处理已取消时不留下半成品', async () => {
    await withTempDirectory(async (directory) => {
      const attachmentDirectory = join(directory, 'attachments')
      const controller = new AbortController()
      controller.abort()

      await assert.rejects(
        importImageAttachments([{
          kind: 'inline', name: 'cancelled.png', base64: ONE_PIXEL_PNG.toString('base64'),
        }], attachmentDirectory, SESSION_ID, controller.signal),
        /图片处理已取消/,
      )
      assert.deepEqual(await readdir(attachmentDirectory), [])
    })
  })

  it('接收无路径图片的瞬时 Base64，并对混合来源执行原子去重', async () => {
    await withTempDirectory(async (directory) => {
      const attachments = join(directory, 'attachments')
      const [pasted] = await importImageAttachments([{
        kind: 'inline', name: '剪贴板截图.png', base64: ONE_PIXEL_PNG.toString('base64'),
      }], attachments, SESSION_ID)
      assert.ok(pasted)
      assert.equal(pasted.name, '剪贴板截图.png')
      assert.deepEqual(await readFile(join(attachments, pasted.storageName)), ONE_PIXEL_PNG)

      await assert.rejects(
        importImageAttachments([{
          kind: 'inline', name: 'broken.png', base64: 'not-base64',
        }], attachments, SESSION_ID),
        /编码无效/,
      )

      const source = join(directory, 'same.png')
      const duplicateBatch = join(directory, 'duplicate-batch')
      await writeFile(source, ONE_PIXEL_PNG)
      await assert.rejects(
        importImageAttachments([
          { kind: 'path', path: source },
          { kind: 'inline', name: 'same-copy.png', base64: ONE_PIXEL_PNG.toString('base64') },
        ], duplicateBatch, SESSION_ID),
        /不能重复添加/,
      )
      assert.deepEqual(await readdir(duplicateBatch), [])
    })
  })

  it('长期历史只存附件引用，视觉请求边界才装载 Base64', async () => {
    await withTempDirectory(async (directory) => {
      const source = join(directory, 'screen.png')
      const attachments = join(directory, 'attachments')
      await writeFile(source, ONE_PIXEL_PNG)
      const imported = await importImageAttachments(
        [{ kind: 'path', path: source }], attachments, SESSION_ID,
      )
      const runtime = [createImageUserMessage('分析截图', imported)]

      const persisted = dehydrateImageMessages(runtime)
      const persistedJson = JSON.stringify(persisted)
      assert.doesNotMatch(persistedJson, /iVBORw0KGgo/)
      assert.match(persistedJson, /whycode-attachment-ref:v1:/)
      assert.doesNotThrow(() => modelMessageSchema.parse(persisted[0]))
      assert.deepEqual(persisted, runtime)

      const request = await messagesForModel(persisted, true, attachments, imported)
      assert.match(JSON.stringify(request), /iVBORw0KGgo/)
      assert.match(JSON.stringify(runtime), /whycode-attachment-ref:v1:/)
      await assert.rejects(
        messagesForModel(persisted, true, attachments, []),
        /缺少权威元数据/,
      )
    })
  })

  it('非视觉模型只收到明确占位，不读取或发送图片数据', async () => {
    const message = createImageUserMessage('这张图有什么问题？', [{
      id: '22222222-2222-4222-8222-222222222222',
      sessionId: SESSION_ID,
      name: 'screen.png',
      storageName: '22222222-2222-4222-8222-222222222222.png',
      mediaType: 'image/png',
      byteLength: ONE_PIXEL_PNG.byteLength,
      width: 1,
      height: 1,
    }])

    const [adapted] = await messagesForModel([message], false)
    assert.ok(adapted && typeof adapted.content !== 'string')
    assert.equal(adapted.content.some((part) => part.type === 'file' || part.type === 'image'), false)
    assert.match(JSON.stringify(adapted), /当前模型不支持识图/)
    assert.doesNotMatch(JSON.stringify(adapted), /iVBORw0KGgo/)
  })

  it('拒绝伪装格式和超大像素图片', async () => {
    await withTempDirectory(async (directory) => {
      const fake = join(directory, 'fake.png')
      await writeFile(fake, 'not an image')
      await assert.rejects(
        importImageAttachments(
          [{ kind: 'path', path: fake }], join(directory, 'attachments'), SESSION_ID,
        ),
        /只支持真实的/,
      )

      const gif = Buffer.alloc(10)
      gif.write('GIF89a', 0, 'ascii')
      gif.writeUInt16LE(1, 6)
      gif.writeUInt16LE(1, 8)
      const gifPath = join(directory, 'unsupported.gif')
      await writeFile(gifPath, gif)
      await assert.rejects(
        importImageAttachments(
          [{ kind: 'path', path: gifPath }], join(directory, 'attachments'), SESSION_ID,
        ),
        /只支持真实的 PNG、JPEG 或 WebP/,
      )

      const huge = Buffer.alloc(24)
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(huge)
      huge.write('IHDR', 12, 'ascii')
      huge.writeUInt32BE(9_000, 16)
      huge.writeUInt32BE(1, 20)
      const hugePath = join(directory, 'huge.png')
      await writeFile(hugePath, huge)
      await assert.rejects(
        importImageAttachments(
          [{ kind: 'path', path: hugePath }], join(directory, 'attachments'), SESSION_ID,
        ),
        /分辨率过大/,
      )
    })
  })

  it('批量导入任一图片失败时回收本批全部文件', async () => {
    await withTempDirectory(async (directory) => {
      const valid = join(directory, 'valid.png')
      const fake = join(directory, 'fake.png')
      const attachments = join(directory, 'attachments')
      await writeFile(valid, ONE_PIXEL_PNG)
      await writeFile(fake, 'not an image')

      await assert.rejects(
        importImageAttachments([
          { kind: 'path', path: valid },
          { kind: 'path', path: fake },
        ], attachments, SESSION_ID),
        /只支持真实的/,
      )
      assert.deepEqual(await readdir(attachments), [])
    })
  })
})

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'whycode-images-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function noisyImage(format: 'png' | 'jpeg' | 'webp'): Promise<Buffer> {
  const pipeline = sharp(randomBytes(64 * 64 * 3), {
    raw: { width: 64, height: 64, channels: 3 },
  })
  if (format === 'png') return pipeline.png({ compressionLevel: 0 }).toBuffer()
  if (format === 'jpeg') return pipeline.jpeg({ quality: 95 }).toBuffer()
  return pipeline.webp({ quality: 90 }).toBuffer()
}

function solidPng(background: string): Promise<Buffer> {
  return sharp({
    create: { width: 32, height: 32, channels: 3, background },
  }).png({ compressionLevel: 0, adaptiveFiltering: false }).toBuffer()
}
