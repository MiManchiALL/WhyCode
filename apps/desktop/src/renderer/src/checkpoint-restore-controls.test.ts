import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { restoreConfirmationActions } from './checkpoint-restore-controls.ts'

describe('检查点回滚确认控件', () => {
  it('仅文件把取消留在原位，把确认错开到右侧', () => {
    assert.deepEqual(restoreConfirmationActions('files'), [
      { label: '取消', action: 'cancel' },
      { label: '确认', action: 'confirm' },
    ])
  })

  it('文件和对话把取消留在原位，把确认错开到左侧', () => {
    assert.deepEqual(restoreConfirmationActions('files-and-chat'), [
      { label: '确认', action: 'confirm' },
      { label: '取消', action: 'cancel' },
    ])
  })
})
