import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  appendImageDrafts,
  prepareImageDrafts,
  releaseImageDrafts,
  restoredImageDrafts,
  type ImageDraft,
} from './image-draft.ts'
import { USER_IMAGE_ATTACHMENT_MAX_COUNT } from '@whycode/core/image-limits'
import type { BrowserReferenceSource } from '@whycode/core/browser-reference'

describe('图片草稿传输', () => {
  it('停止提交后不编码正在读取的图片，也不继续读取后续图片', async t => {
    const abort = new AbortController()
    let finishRead!: (bytes: ArrayBuffer) => void
    const first = { arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { finishRead = resolve }) } as File
    const readNext = t.mock.fn(async () => new ArrayBuffer(1))
    const drafts: ImageDraft[] = [
      { id: 'first', kind: 'memory', name: 'first.png', previewUrl: 'blob:1', file: first },
      { id: 'next', kind: 'memory', name: 'next.png', previewUrl: 'blob:2', file: { arrayBuffer: readNext } as unknown as File },
    ]
    const preparing = prepareImageDrafts(drafts, abort.signal)
    abort.abort()
    finishRead(new ArrayBuffer(0))
    await assert.rejects(preparing, { name: 'AbortError' })
    assert.equal(readNext.mock.callCount(), 0)
    await assert.rejects(prepareImageDrafts(drafts, abort.signal), { name: 'AbortError' })
  })

  it('网页引用的批注随草稿提交和恢复，不依赖浏览器页面仍然存在', async () => {
    const source: BrowserReferenceSource = { kind: 'browser-reference', id: crypto.randomUUID(), comment: '修改标题',
      page: { url: 'file:///home/index.html', title: 'Page' }, targets: [{ id: crypto.randomUUID(), kind: 'element', label: 'h1',
        selector: '#title', rect: { x: 0, y: 10, width: 80, height: 20 }, imageRect: { x: 0, y: 0, width: 100, height: 60 }, crop: { x: 0, y: 0, width: 100, height: 60 },
        viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, zoom: 1 }, capturedAt: new Date().toISOString() }] }
    const file = new File([Uint8Array.from([1, 2, 3])], 'reference.jpg', { type: 'image/jpeg' })
    const [input] = await prepareImageDrafts([{ kind: 'memory', id: 'draft', name: file.name, file, previewUrl: 'blob:test', source }])
    assert.ok(input?.kind === 'inline')
    assert.deepEqual(input.source, source)
    const attachment = { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), name: file.name, storageName: 'test.jpg',
      mediaType: 'image/jpeg' as const, byteLength: 3, width: 100, height: 60, source }
    const [restored] = restoredImageDrafts([{ id: 'pending', text: '', attachments: [attachment] }])
    assert.deepEqual(restored?.source, source)
    assert.deepEqual(await prepareImageDrafts([restored!]), [{ kind: 'stored', attachmentId: attachment.id }])
  })
  it('混合本地文件与剪贴板图片时保留原始顺序', async () => {
    const file = {
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    } as File
    const drafts: ImageDraft[] = [
      { id: 'memory', kind: 'memory', name: 'paste.png', previewUrl: 'blob:1', file },
      { id: 'path', kind: 'path', name: 'picked.png', previewUrl: 'blob:2', file, path: 'E:\\picked.png' },
    ]

    assert.deepEqual(await prepareImageDrafts(drafts), [
      { kind: 'inline', name: 'paste.png', base64: 'AQID' },
      { kind: 'path', path: 'E:\\picked.png' },
    ])
  })

  it('拒绝发送空的剪贴板图片', async () => {
    const file = { arrayBuffer: async () => new ArrayBuffer(0) } as File
    await assert.rejects(
      prepareImageDrafts([
        { id: 'empty', kind: 'memory', name: 'empty.png', previewUrl: 'blob:empty', file },
      ]),
      /为空或超过/,
    )
  })

  it('把中断恢复图片保留为不透明 ID，不在 Renderer 重新读取 Base64', async () => {
    const attachment = {
      id: '22222222-2222-4222-8222-222222222222',
      sessionId: '11111111-1111-4111-8111-111111111111',
      name: 'queued.png',
      storageName: '22222222-2222-4222-8222-222222222222.png',
      mediaType: 'image/png' as const,
      sha256: 'a'.repeat(64),
      byteLength: 100,
      width: 20,
      height: 10,
    }
    const [draft] = restoredImageDrafts([{
      id: 'input-1',
      text: '恢复图片',
      attachments: [attachment],
    }])
    assert.ok(draft?.kind === 'stored')
    assert.match(draft.previewUrl, /^whycode-attachment:/)
    assert.deepEqual(await prepareImageDrafts([draft]), [{
      kind: 'stored',
      attachmentId: attachment.id,
    }])
  })

  it('选择、粘贴与拖放共用十张上限', () => {
    const files = Array.from(
      { length: USER_IMAGE_ATTACHMENT_MAX_COUNT + 1 },
      (_, index) => new File([`image-${index}`], `image-${index}.png`, { type: 'image/png' }),
    )
    const result = appendImageDrafts([], files)
    try {
      assert.equal(result.drafts.length, USER_IMAGE_ATTACHMENT_MAX_COUNT)
      assert.equal(result.duplicateOrLimit, 1)
    } finally {
      releaseImageDrafts(result.drafts)
    }
  })
})
