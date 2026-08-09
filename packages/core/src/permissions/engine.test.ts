import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { z } from 'zod'
import { buildTool } from '../tools/tool.ts'
import {
  checkInitialToolApproval,
  checkToolAuthorization,
  checkToolPermission,
} from './engine.ts'
import { createPermissionContext } from './types.ts'

const controlTool = buildTool({
  name: 'ControlProbe',
  description: '控制面权限探针',
  prompt: '控制面权限探针',
  inputSchema: z.object({}),
  isReadOnly: false,
  kind: 'control',
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

const executeTool = buildTool({
  name: 'ExecuteProbe',
  description: '执行权限探针',
  prompt: '执行权限探针',
  inputSchema: z.object({ path: z.string() }),
  isReadOnly: false,
  kind: 'execute',
  extractPaths: ({ path }) => [path],
  async execute() {
    return { data: 'ok', isError: false }
  },
})

const unboundedEditTool = buildTool({
  name: 'UnboundedEditProbe',
  description: '未声明资源边界的编辑权限探针',
  prompt: '未声明资源边界的编辑权限探针',
  inputSchema: z.object({}),
  isReadOnly: false,
  kind: 'edit',
  async execute() {
    return { data: 'ok', isError: false }
  },
})

const multiPathEditTool = buildTool({
  name: 'MultiPathEditProbe',
  description: '多路径编辑权限探针',
  prompt: '多路径编辑权限探针',
  inputSchema: z.object({ paths: z.array(z.string()) }),
  isReadOnly: false,
  kind: 'edit',
  extractPaths: ({ paths }) => paths,
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

const privacyPathReadTool = buildTool({
  name: 'PrivacyPathReadProbe',
  description: '带路径的隐私读取探针',
  prompt: '带路径的隐私读取探针',
  inputSchema: z.object({ path: z.string() }),
  isReadOnly: true,
  kind: 'read',
  initialApprovalReason: '会读取隐私内容',
  extractPaths: ({ path }) => [path],
  async execute() {
    return { data: 'ok', isError: false }
  },
})

const projectProcessTool = buildTool({
  name: 'ProjectProcessProbe',
  description: '项目进程权限探针',
  prompt: '项目进程权限探针',
  inputSchema: z.object({}),
  isReadOnly: false,
  kind: 'execute',
  initialApprovalReason: '项目配置会启动外部进程',
  async execute() {
    return { data: 'ok', isError: false }
  },
})

describe('统一权限决策', () => {
  it('只读模式在项目内外均直接拒绝写和命令，不产生可批准入口', () => {
    const context = createPermissionContext('C:\\workspace')
    context.mode = 'readonly'
    context.additionalDirs.push('D:\\outside')
    context.sessionAllowedTools.push(editTool.name, executeTool.name, projectProcessTool.name)

    for (const [tool, input] of [
      [editTool, { path: 'src\\index.ts' }],
      [editTool, { path: 'D:\\outside\\result.txt' }],
      [executeTool, { path: 'D:\\another\\build.cmd' }],
      [projectProcessTool, {}],
    ] as const) {
      assert.deepEqual(checkToolAuthorization(tool, input, context), {
        behavior: 'deny',
        reason: '当前为只读模式，不允许修改或执行',
      })
    }
  })

  it('默认与自动编辑档的项目外副作用只生成一项路径审批', () => {
    for (const mode of ['default', 'acceptEdits'] as const) {
      const context = createPermissionContext('C:\\workspace')
      context.mode = mode
      assert.deepEqual(
        checkToolAuthorization(editTool, { path: 'D:\\outside\\result.txt' }, context),
        {
          behavior: 'ask',
          reason: '路径超出项目目录：D:\\outside\\result.txt',
          suggestion: { kind: 'add-dir', dir: 'D:\\outside\\result.txt' },
        },
      )
      assert.equal(
        checkToolAuthorization(
          executeTool,
          { path: 'D:\\outside\\build.cmd' },
          context,
        ).behavior,
        'ask',
      )
    }
  })

  it('项目外路径与首次隐私审批合并为一张卡，路径记忆边界优先', () => {
    const context = createPermissionContext('C:\\workspace')
    assert.deepEqual(
      checkToolAuthorization(
        privacyPathReadTool,
        { path: 'D:\\outside\\screen.png' },
        context,
      ),
      {
        behavior: 'ask',
        reason: '路径超出项目目录：D:\\outside\\screen.png；会读取隐私内容',
        suggestion: { kind: 'add-dir', dir: 'D:\\outside\\screen.png' },
      },
    )
  })

  it('同一调用的敏感路径和全部越界路径共同展示，批准条件不会短路', () => {
    const context = createPermissionContext('C:\\workspace')
    assert.deepEqual(
      checkToolAuthorization(
        multiPathEditTool,
        {
          paths: [
            'C:\\workspace\\.env',
            'D:\\outside\\first.txt',
            'E:\\outside\\second.txt',
          ],
        },
        context,
      ),
      {
        behavior: 'ask',
        reason: [
          '涉及敏感路径：C:\\workspace\\.env',
          '路径超出项目目录：D:\\outside\\first.txt、E:\\outside\\second.txt',
        ].join('；'),
      },
    )
  })

  it('讨论档的项目写硬拒绝先于敏感路径审批', () => {
    const context = createPermissionContext('C:\\workspace', {
      scratchDir: 'C:\\scratch\\agent-b',
    })
    const decision = checkToolAuthorization(editTool, { path: '.env' }, context)
    assert.equal(decision.behavior, 'deny')
    assert.match(
      decision.behavior === 'deny' ? decision.reason : '',
      /讨论阶段禁止修改原项目/,
    )
  })

  it('讨论档命令未完全限定在 scratch 时直接拒绝，不提供审批绕过', () => {
    const context = createPermissionContext('C:\\workspace', {
      scratchDir: 'C:\\scratch\\agent-b',
    })
    for (const decision of [
      checkToolAuthorization(projectProcessTool, {}, context),
      checkToolAuthorization(
        executeTool,
        { path: 'C:\\workspace\\package.json' },
        context,
      ),
    ]) {
      assert.equal(decision.behavior, 'deny')
      assert.match(
        decision.behavior === 'deny' ? decision.reason : '',
        /讨论阶段命令/,
      )
    }
  })

  it('讨论档修改未声明资源路径时按 fail-closed 直接拒绝', () => {
    const context = createPermissionContext('C:\\workspace', {
      scratchDir: 'C:\\scratch\\agent-b',
    })
    assert.deepEqual(checkToolAuthorization(unboundedEditTool, {}, context), {
      behavior: 'deny',
      reason: '讨论阶段修改未声明临时工作区内的资源边界',
    })
  })

  it('只读仍允许读，但项目外读取必须经过路径审批', () => {
    const context = createPermissionContext('C:\\workspace')
    context.mode = 'readonly'
    assert.deepEqual(
      checkToolPermission(
        privacyPathReadTool,
        { path: 'D:\\outside\\screen.png' },
        context,
      ),
      {
        behavior: 'ask',
        reason: '路径超出项目目录：D:\\outside\\screen.png',
        suggestion: { kind: 'add-dir', dir: 'D:\\outside\\screen.png' },
      },
    )
  })

  it('可疑 Windows 路径在全自动档和首次审批之前仍直接拒绝', () => {
    const context = createPermissionContext('C:\\workspace')
    context.mode = 'auto'
    const decision = checkToolAuthorization(
      privacyPathReadTool,
      { path: 'C:\\workspace\\CON' },
      context,
    )
    assert.equal(decision.behavior, 'deny')
    assert.match(decision.behavior === 'deny' ? decision.reason : '', /DOS 设备名/)
  })
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
    assert.equal(checkToolPermission(editTool, { path: '.env' }, context).behavior, 'allow')
    assert.equal(
      checkToolPermission(editTool, { path: 'D:\\outside\\result.txt' }, context).behavior,
      'allow',
    )
  })

  it('会话记住允许后不再重复首次提示', () => {
    const context = createPermissionContext('C:\\workspace')
    context.sessionAllowedTools.push(privacyReadTool.name)

    assert.equal(checkInitialToolApproval(privacyReadTool, context), null)
  })

  it('全自动档也跳过项目进程等显式信任提示', () => {
    const context = createPermissionContext('C:\\workspace')
    context.mode = 'auto'

    assert.equal(checkInitialToolApproval(projectProcessTool, context), null)
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

    context.mode = 'auto'
    assert.deepEqual(checkToolPermission(projectProcessTool, {}, context), {
      behavior: 'deny',
      reason: '讨论阶段命令未限定在临时工作区内（请显式传 cwd 为你的 scratch 目录）',
    })
  })
})
