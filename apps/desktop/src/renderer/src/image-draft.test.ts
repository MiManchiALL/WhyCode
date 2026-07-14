import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { prepareImageDrafts, type ImageDraft } from './image-draft.ts'

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
})
