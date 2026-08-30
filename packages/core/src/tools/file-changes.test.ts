import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { countLineChanges } from './file-changes.ts'

describe('文件行变更统计', () => {
  it('统计新建和删除文件', () => {
    assert.deepEqual(countLineChanges('', 'alpha\nbeta\n'), { added: 2, removed: 0 })
    assert.deepEqual(countLineChanges('alpha\nbeta\n', ''), { added: 0, removed: 2 })
  })

  it('把单行修改计为删除一行并增加一行', () => {
    assert.deepEqual(
      countLineChanges('alpha\nbefore\nomega\n', 'alpha\nafter\nomega\n'),
      { added: 1, removed: 1 },
    )
  })

  it('分别统计纯插入和纯删除', () => {
    assert.deepEqual(
      countLineChanges('alpha\nomega\n', 'alpha\nbeta\nomega\n'),
      { added: 1, removed: 0 },
    )
    assert.deepEqual(
      countLineChanges('alpha\nbeta\nomega\n', 'alpha\nomega\n'),
      { added: 0, removed: 1 },
    )
  })

  it('不会把相隔较远修改之间的未改内容计入统计', () => {
    assert.deepEqual(
      countLineChanges(
        'one\nbefore-a\nshared-1\nshared-2\nbefore-b\nlast\n',
        'one\nafter-a\nshared-1\nshared-2\nafter-b\nlast\n',
      ),
      { added: 2, removed: 2 },
    )
  })

  it('文件末尾换行变化算作一行替换', () => {
    assert.deepEqual(countLineChanges('alpha', 'alpha\n'), { added: 1, removed: 1 })
  })

  it('对短序列穷举结果与动态规划的最小编辑距离一致', () => {
    const sequences = lineSequences(['a', 'b'], 4)
    for (const before of sequences) {
      for (const after of sequences) {
        assert.deepEqual(
          countLineChanges(asText(before), asText(after)),
          expectedChanges(before, after),
          `${before.join(',')} -> ${after.join(',')}`,
        )
      }
    }
  })
})

function lineSequences(alphabet: readonly string[], maximumLength: number): string[][] {
  const result: string[][] = [[]]
  for (let length = 1; length <= maximumLength; length++) {
    const previous = result.filter((sequence) => sequence.length === length - 1)
    result.push(...previous.flatMap((sequence) =>
      alphabet.map((value) => [...sequence, value])))
  }
  return result
}

function asText(lines: readonly string[]): string {
  return lines.length ? `${lines.join('\n')}\n` : ''
}

function expectedChanges(before: readonly string[], after: readonly string[]) {
  const lengths = Array.from(
    { length: before.length + 1 },
    () => Array<number>(after.length + 1).fill(0),
  )
  for (let left = 1; left <= before.length; left++) {
    for (let right = 1; right <= after.length; right++) {
      lengths[left]![right] = before[left - 1] === after[right - 1]
        ? lengths[left - 1]![right - 1]! + 1
        : Math.max(lengths[left - 1]![right]!, lengths[left]![right - 1]!)
    }
  }
  const common = lengths[before.length]![after.length]!
  return { added: after.length - common, removed: before.length - common }
}
