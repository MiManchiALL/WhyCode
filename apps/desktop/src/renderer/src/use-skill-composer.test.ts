import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createComposerCommands } from './use-skill-composer.ts'

describe('输入框功能命令目录', () => {
  it('没有对话消息时不提供压缩命令', () => {
    assert.deepEqual(createComposerCommands({
      compactAvailable: false,
      compactDisabled: false,
      forkAvailable: false,
      forkDisabled: false,
    }), [])
  })

  it('已有对话时提供压缩命令，并保留运行态禁用标记', () => {
    assert.deepEqual(createComposerCommands({
      compactAvailable: true,
      compactDisabled: true,
      forkAvailable: true,
      forkDisabled: false,
    }), [{
      id: 'fork',
      name: '在新对话中继续',
      description: '从最近一次完整模型回复创建独立对话',
      keywords: ['fork', 'branch', '分支'],
      disabled: false,
    }, {
      id: 'compact',
      name: '压缩',
      description: '压缩当前会话上下文，释放上下文空间',
      keywords: ['compact', 'context'],
      disabled: true,
    }])
  })

  it('会话运行时不把 Fork 命令放进斜杠菜单', () => {
    assert.deepEqual(createComposerCommands({
      compactAvailable: true,
      compactDisabled: true,
      forkAvailable: false,
      forkDisabled: false,
    }), [{
      id: 'compact',
      name: '压缩',
      description: '压缩当前会话上下文，释放上下文空间',
      keywords: ['compact', 'context'],
      disabled: true,
    }])
  })
})
