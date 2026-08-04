import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isWellFormedUnicode, unicodeSafePrefix, unicodeSafeSuffix } from './text.ts'

describe('Unicode 安全截断', () => {
  it('前缀和后缀都不在代理项对中间截断', () => {
    const value = 'a😀b'
    assert.equal(unicodeSafePrefix(value, 2), 'a')
    assert.equal(unicodeSafeSuffix(value, 2), 'b')
    assert.equal(isWellFormedUnicode(unicodeSafePrefix(value, 2)), true)
    assert.equal(isWellFormedUnicode(unicodeSafeSuffix(value, 2)), true)
  })
})
