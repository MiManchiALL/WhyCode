import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collectPastedImageFiles } from './image-paste.ts'

const png = { name: 'image.png', type: 'image/png' } as File
const text = { name: 'notes.txt', type: 'text/plain' } as File

describe('图片粘贴识别', () => {
  it('从剪贴板 item 中提取图片并忽略普通文件', () => {
    const files = collectPastedImageFiles({
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => text },
        { kind: 'file', getAsFile: () => png },
      ],
      files: [],
    })
    assert.deepEqual(files, [png])
  })

  it('item 不提供文件时回退到 FileList，普通文本粘贴返回空', () => {
    assert.deepEqual(collectPastedImageFiles({ items: [], files: [png] }), [png])
    assert.deepEqual(collectPastedImageFiles({ items: [], files: [text] }), [])
  })
})
