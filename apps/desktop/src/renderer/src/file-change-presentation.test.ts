import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildFileDiffHunks,
  firstChangedLine,
} from './file-change-presentation.ts'

describe('文件变更展示投影', () => {
  it('生成带上下文的多个差异块并定位第一处新增行', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n')
    const after = ['a', 'B', 'c', 'd', 'e', 'f', 'g', 'H', 'i'].join('\n')
    const hunks = buildFileDiffHunks(before, after, 1)
    assert.equal(hunks.length, 2)
    assert.deepEqual(
      hunks[0]?.lines.filter((line) => line.kind !== 'context').map((line) => [
        line.kind,
        line.oldLine,
        line.newLine,
        line.text,
      ]),
      [
        ['removed', 2, null, 'b'],
        ['added', null, 2, 'B'],
      ],
    )
    assert.equal(firstChangedLine(before, after), 2)
  })
})
