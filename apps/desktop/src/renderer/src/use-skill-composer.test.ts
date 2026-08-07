import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createComposerCommands } from './use-skill-composer.ts'

describe('输入框功能命令目录', () => {
  it('没有对话消息时不提供压缩命令', () => {
    assert.deepEqual(createComposerCommands(false, false), [])
  })

  it('已有对话时提供压缩命令，并保留运行态禁用标记', () => {
    assert.deepEqual(createComposerCommands(true, true), [{
      id: 'compact',
      name: '压缩',
      description: '压缩当前会话上下文，释放上下文空间',
      keywords: ['compact', 'context'],
      disabled: true,
    }])
  })
})
