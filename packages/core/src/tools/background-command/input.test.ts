import assert from 'node:assert/strict'
import { it } from 'node:test'
import { asSchema } from 'ai'
import { createCommandTools, CommandSessionManager } from './index.ts'
import { validateToolInput, toolBehavior } from '../tool.ts'
import { checkToolPermission } from '../../permissions/engine.ts'
import { createPermissionContext } from '../../permissions/types.ts'

const tool = createCommandTools(new CommandSessionManager('unused'), 'session').manageCommand
const taskId = crypto.randomUUID()

it('向供应商暴露六个平铺参数，校验缺失、无关和越界参数', async () => {
  const schema = await asSchema(tool.inputSchema).jsonSchema
  assert.deepEqual(Object.keys(schema.properties ?? {}), ['action', 'taskId', 'input', 'offset', 'waitMs', 'reason'])
  assert.deepEqual(schema.required, ['action'])
  for (const input of [
    { action: 'list' }, { action: 'read', taskId }, { action: 'read', taskId, offset: 12, waitMs: 30_000 },
    { action: 'write', taskId, input: '\n' }, { action: 'close', taskId },
    { action: 'close', taskId, input: 'last\n' }, { action: 'stop', taskId, reason: '完成检查' },
  ]) assert.equal((await validateToolInput(tool, input)).success, true, JSON.stringify(input))
  for (const input of [
    {}, { action: 'unknown' }, { action: 'read' }, { action: 'write', taskId },
    { action: 'close', taskId: 'other' }, { action: 'list', taskId }, { action: 'list', input: 'ignored?' },
    { action: 'write', taskId, input: 'x', offset: 1 }, { action: 'stop', taskId, input: 'x' },
    { action: 'close', taskId, reason: 'x' }, { action: 'read', taskId, waitMs: 30_001 },
    { action: 'read', taskId, offset: -1 }, { action: 'read', taskId, maxBytes: 1024 },
    { action: 'write', taskId, input: 'x', appendNewline: true },
  ]) assert.equal((await validateToolInput(tool, input)).success, false, JSON.stringify(input))
})

it('只读档允许查询与停止，不能借统一工具名或记住授权写入和发送 EOF', async () => {
  const context = createPermissionContext(process.cwd())
  context.mode = 'readonly'
  context.sessionAllowedTools = [tool.name]
  for (const action of ['list', 'read', 'stop', 'write', 'close']) {
    const input = { action, ...(action !== 'list' ? { taskId } : {}), ...(action === 'write' ? { input: 'yes\n' } : {}) }
    const parsed = await validateToolInput(tool, input)
    assert.ok(parsed.success)
    const behavior = toolBehavior(tool, parsed.value)
    assert.equal(behavior.isReadOnly, action === 'list' || action === 'read')
    assert.equal((await checkToolPermission(tool, parsed.value, context)).behavior,
      action === 'write' || action === 'close' ? 'deny' : 'allow')
  }
  context.mode = 'default'
  context.sessionAllowedTools = []
  assert.equal((await checkToolPermission(tool, { action: 'write', taskId, input: 'x' }, context)).behavior, 'ask')
  assert.equal((await checkToolPermission(tool, { action: 'close', taskId }, context)).behavior, 'ask')
})
