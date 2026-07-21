import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { composerKeyAction } from './composer-key.ts'

describe('主输入框键盘行为', () => {
  it('Enter 发送，Ctrl+Enter 立即插话', () => {
    assert.equal(action(), 'send')
    assert.equal(action({ ctrlKey: true }), 'send-immediately')
  })

  it('Shift+Enter 始终换行', () => {
    assert.equal(action({ shiftKey: true }), 'newline')
    assert.equal(action({ shiftKey: true, ctrlKey: true }), 'newline')
  })

  it('输入法组字和非 Enter 按键不触发提交', () => {
    assert.equal(action({ isComposing: true }), 'ignore')
    assert.equal(action({ key: 'a' }), 'ignore')
  })
})

function action(overrides: Partial<Parameters<typeof composerKeyAction>[0]> = {}) {
  return composerKeyAction({
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    isComposing: false,
    ...overrides,
  })
}
