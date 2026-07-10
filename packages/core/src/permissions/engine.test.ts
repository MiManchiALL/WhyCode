import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { buildTool } from '../tools/tool.ts'
import { checkToolPermission } from './engine.ts'
import { createPermissionContext } from './types.ts'

const controlTool = buildTool({
  name: 'ControlProbe',
  description: '控制面权限探针',
  prompt: '控制面权限探针',
  inputSchema: z.object({}),
  isReadOnly: false,
  kind: 'control',
  availableWithoutProject: true,
  async execute() {
    return { data: 'ok', isError: false }
  },
})

const editTool = buildTool({
  name: 'EditProbe',
  description: '编辑权限探针',
  prompt: '编辑权限探针',
  inputSchema: z.object({ path: z.string() }),
  isReadOnly: false,
  kind: 'edit',
  extractPaths: ({ path }) => [path],
  async execute() {
    return { data: 'ok', isError: false }
  },
})

describe('控制面工具权限', () => {
  it('只读模式允许控制状态，但继续拒绝文件修改', () => {
    const context = createPermissionContext('C:\\workspace')
    context.mode = 'readonly'

    assert.deepEqual(checkToolPermission(controlTool, {}, context), { behavior: 'allow' })
    assert.equal(
      checkToolPermission(editTool, { path: 'src\\index.ts' }, context).behavior,
      'deny',
    )
  })

  it('讨论模式允许协议控制状态，但继续限制项目文件修改', () => {
    const context = createPermissionContext('C:\\workspace', {
      scratchDir: 'C:\\scratch\\agent-b',
    })

    assert.deepEqual(checkToolPermission(controlTool, {}, context), { behavior: 'allow' })
    assert.equal(
      checkToolPermission(editTool, { path: 'src\\index.ts' }, context).behavior,
      'deny',
    )
  })
})
