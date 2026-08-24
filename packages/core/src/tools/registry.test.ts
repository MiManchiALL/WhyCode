import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DELETE_FILE_TOOL_NAME, MOVE_FILE_TOOL_NAME } from './file-lifecycle/index.ts'
import { GREP_TOOL_NAME } from './grep/index.ts'
import { GLOB_TOOL_NAME } from './list-glob/index.ts'
import { BUILTIN_TOOLS } from './registry.ts'
import { RUN_COMMAND_TOOL_NAME } from './run-command/index.ts'
import { EDIT_FILE_TOOL_NAME } from './write-edit/index.ts'

describe('内置工具注册表', () => {
  it('注册名唯一，并包含搜索与完整文件生命周期能力', () => {
    const names = BUILTIN_TOOLS.map((tool) => tool.name)
    assert.equal(new Set(names).size, names.length)
    for (const name of [
      GLOB_TOOL_NAME,
      GREP_TOOL_NAME,
      EDIT_FILE_TOOL_NAME,
      DELETE_FILE_TOOL_NAME,
      MOVE_FILE_TOOL_NAME,
    ]) {
      assert.ok(names.includes(name), `${name} 未注册`)
    }
  })

  it('结构化写工具均声明串行语义和精确检查点', () => {
    for (const name of [EDIT_FILE_TOOL_NAME, DELETE_FILE_TOOL_NAME, MOVE_FILE_TOOL_NAME]) {
      const tool = BUILTIN_TOOLS.find((candidate) => candidate.name === name)
      assert.ok(tool)
      assert.equal(tool.isReadOnly, false)
      assert.equal(tool.kind, 'edit')
      assert.equal(typeof tool.checkpointScope, 'function')
    }
    assert.equal(BUILTIN_TOOLS.some((tool) => tool.name === 'BatchEdit'), false)
  })

  it('RunCommand 保持执行审批但不承诺文件回滚', () => {
    const tool = BUILTIN_TOOLS.find((candidate) => candidate.name === RUN_COMMAND_TOOL_NAME)
    assert.ok(tool)
    assert.equal(tool.isReadOnly, false)
    assert.equal(tool.kind, 'execute')
    assert.equal(tool.checkpointScope, undefined)
    assert.match(tool.prompt, /不要塞进 python -c 或 node -e/)
    assert.match(tool.prompt, /导入第三方包前先检查环境是否已有/)
  })
})
