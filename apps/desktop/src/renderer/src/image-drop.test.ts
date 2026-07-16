import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyAttachmentFiles, collectDroppedFiles, isFileDrag } from './image-drop.ts'

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

  it('把混合拖放拆成图片、PDF 与不支持文件', () => {
    const image = { name: 'screen.PNG', type: '' } as File
    const pdf = { name: 'manual', type: 'application/pdf' } as File
    const other = { name: 'archive.zip', type: 'application/zip' } as File
    assert.deepEqual(classifyAttachmentFiles([image, pdf, other]), {
      images: [image],
      pdfs: [pdf],
      unsupported: [other],
    })
  })
})
