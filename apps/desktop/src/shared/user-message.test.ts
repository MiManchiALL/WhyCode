import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { attachmentFallbackText } from './user-message.ts'

describe('附件消息兜底正文', () => {
  it('纯图片输入保持空正文', () => {
    assert.equal(attachmentFallbackText(1, 0), '')
    assert.equal(attachmentFallbackText(10, 0), '')
  })

  it('PDF 与混合附件仍生成对应的读取指令', () => {
    assert.equal(attachmentFallbackText(0, 1), '请分析这些 PDF。')
    assert.equal(attachmentFallbackText(2, 1), '请分析这些附件。')
    assert.equal(attachmentFallbackText(0, 0), '')
  })
})
