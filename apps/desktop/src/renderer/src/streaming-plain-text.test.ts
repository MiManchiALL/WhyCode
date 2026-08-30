import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { incrementalTextSuffix } from './streaming-plain-text.ts'

describe('流式纯文本增量', () => {
  it('只返回新增后缀', () => {
    assert.equal(incrementalTextSuffix('', '开始'), '开始')
    assert.equal(incrementalTextSuffix('正在思考', '正在思考下一步'), '下一步')
    assert.equal(incrementalTextSuffix('没有变化', '没有变化'), '')
  })

  it('文本缩短或被替换时要求完整重置', () => {
    assert.equal(incrementalTextSuffix('旧的完整推理', '新推理'), null)
    assert.equal(incrementalTextSuffix('abcdefgh', 'abcdWXYZmore'), null)
  })

  it('长文本只凭固定首尾探针确认正常追加', () => {
    const previous = `head-${'x'.repeat(10_000)}-tail`
    assert.equal(incrementalTextSuffix(previous, `${previous}-next`), '-next')
  })
})
