import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { collectDroppedFiles, isFileDrag } from './image-drop.ts'

describe('图片拖放', () => {
  it('只接管包含文件的拖放，不阻止普通文本拖放', () => {
    assert.equal(isFileDrag({ types: ['text/plain', 'Files'] }), true)
    assert.equal(isFileDrag({ types: ['text/plain'] }), false)
  })

  it('保持 DataTransfer 中的文件顺序', () => {
    const first = { name: 'first.png' } as File
    const second = { name: 'second.webp' } as File
    const files = collectDroppedFiles({
      files: [first, second] as unknown as FileList,
    })

    assert.deepEqual(files, [first, second])
  })
})
