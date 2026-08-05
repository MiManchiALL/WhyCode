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

describe('图片草稿传输', () => {
  it('混合本地文件与剪贴板图片时保留原始顺序', async () => {
    const file = {
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    } as File
    const drafts: ImageDraft[] = [
      { id: 'memory', kind: 'memory', name: 'paste.png', previewUrl: 'blob:1', file },
      { id: 'path', kind: 'path', name: 'picked.png', previewUrl: 'blob:2', path: 'E:\\picked.png' },
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
