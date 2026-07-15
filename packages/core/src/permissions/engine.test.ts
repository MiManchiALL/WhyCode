import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { buildTool } from '../tools/tool.ts'
import { checkInitialToolApproval, checkToolPermission } from './engine.ts'
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

const privacyReadTool = buildTool({
  name: 'PrivacyReadProbe',
  description: '隐私读权限探针',
  prompt: '隐私读权限探针',
  inputSchema: z.object({}),
  isReadOnly: true,
  kind: 'read',
  initialApprovalReason: '会读取屏幕上的敏感内容',
  async execute() {
    return { data: 'ok', isError: false }
  },
})

describe('工具首次隐私审批', () => {
  it('只在全自动档跳过首次提示，其余权限档继续询问', () => {
    const context = createPermissionContext('C:\\workspace')

    for (const mode of ['readonly', 'default', 'acceptEdits'] as const) {
      context.mode = mode
      assert.deepEqual(checkInitialToolApproval(privacyReadTool, context), {
        behavior: 'ask',
        reason: '会读取屏幕上的敏感内容',
        suggestion: { kind: 'allow-tool', toolName: 'PrivacyReadProbe' },
      })
    }

    context.mode = 'auto'
    assert.equal(checkInitialToolApproval(privacyReadTool, context), null)
    assert.equal(
      checkToolPermission(editTool, { path: '.env' }, context).behavior,
      'ask',
      '跳过一次性隐私提示不能绕过敏感路径强制审批',
    )
  })

  it('会话记住允许后不再重复首次提示', () => {
    const context = createPermissionContext('C:\\workspace')
    context.sessionAllowedTools.push(privacyReadTool.name)

    assert.equal(checkInitialToolApproval(privacyReadTool, context), null)
  })
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
