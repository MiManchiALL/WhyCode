import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TaskPlanState } from '@whycode/core'
import { formatTaskToolResult } from '../../../../../packages/core/src/tasks/context.ts'
import type { ToolCall } from './conversation-state.ts'
import { parseTaskToolResult } from './task-tool-result.ts'

function state(): TaskPlanState {
  return {
    version: 1, resumeRequired: false, interruptionReason: null,
    activePlan: {
      id: '12345678-1234-4234-8234-123456789abc', revision: 1,
      goal: '让任务计划结果清晰可读', status: 'active',
      items: [
        { id: 'T1', kind: 'work', outcome: '完成结果解析', status: 'completed', evidence: ['解析检查通过'] },
        { id: 'T2', kind: 'work', outcome: '完成计划展示', status: 'in_progress', evidence: [] },
        { id: 'T3', kind: 'verification', outcome: '验证展示和交互', status: 'pending', evidence: [] },
      ],
    },
  }
}

function call(name: string, snapshot = state(), input: unknown = {}, ok = true): ToolCall {
  return {
    id: 'task-call', name, input, status: ok ? 'done' : 'error', progress: '',
    result: formatTaskToolResult(name, { ok, message: ok ? '计划已更新。' : '请先恢复当前计划。' }, snapshot, snapshot.activePlan?.id),
  }
}

describe('任务计划工具历史详情', () => {
  it('使用 Core 实际结果格式读取创建和恢复后的计划，不从请求推测计划内容', () => {
    for (const name of ['CreateTaskPlan', 'ResumeTaskPlan']) {
      const snapshot = state()
      const result = parseTaskToolResult(call(name, snapshot, { goal: '不应显示的请求目标' }))
      assert.equal(result?.ok, true)
      assert.equal(result?.plan?.goal, snapshot.activePlan?.goal)
      assert.deepEqual(result?.plan?.items, snapshot.activePlan?.items)
      assert.deepEqual(result?.updatedItemIds, [])
    }
  })

  it('从成功结果匹配状态更新、修订和新增项，不为已删除项伪造条目', () => {
    const snapshot = state()
    snapshot.activePlan!.items.splice(2, 0, { id: 'T4', kind: 'work', outcome: '新增结果', status: 'pending', evidence: [] })
    const result = parseTaskToolResult(call('UpdateTaskItem', snapshot, {
      item_id: 'T1', status: 'completed',
      changes: [
        { action: 'edit', item_id: 'T2', outcome: '完成计划展示' },
        { action: 'add', outcome: ' 新增结果 ' },
        { action: 'delete', item_id: 'T5' },
      ],
    }))
    assert.deepEqual(result?.updatedItemIds, ['T1', 'T2', 'T4'])
    assert.deepEqual(result?.plan?.items[0]?.evidence, ['解析检查通过'])
    snapshot.activePlan!.items[1]!.outcome = '新增结果'
    const ambiguous = parseTaskToolResult(call('UpdateTaskItem', snapshot, {
      changes: [{ action: 'add', outcome: '新增结果' }],
    }))
    assert.deepEqual(ambiguous?.updatedItemIds, [])
  })

  it('关闭显示结束结果；失败和未执行调用不会显示为完成更新', () => {
    const snapshot = state()
    snapshot.activePlan = null
    const closed = call('CloseTaskPlan', snapshot)
    closed.result = formatTaskToolResult(closed.name, { ok: true, message: '任务计划已结束。' }, snapshot)
    assert.deepEqual(parseTaskToolResult(closed), { ok: true, message: '任务计划已结束。', plan: null, updatedItemIds: [] })
    assert.deepEqual(parseTaskToolResult(call('UpdateTaskItem', state(), { item_id: 'T2', status: 'completed' }, false)), {
      ok: false, message: '请先恢复当前计划。', plan: null, updatedItemIds: [],
    })
    assert.equal(parseTaskToolResult({ ...call('UpdateTaskItem'), status: 'running' }), null)
    assert.equal(parseTaskToolResult({ ...call('UpdateTaskItem'), status: 'error', result: '调用已取消' }), null)
  })

  it('不把其它工具内容或操作不匹配的协议解释为计划更新', () => {
    const update = call('UpdateTaskItem')
    for (const name of ['mcp__example__search', 'RunCommand', 'CreateTaskPlan']) {
      assert.equal(parseTaskToolResult({ ...update, name }), null)
    }
  })

  it('残缺或不可渲染的结果保留原始详情，不拼出计划状态', () => {
    const update = call('UpdateTaskItem')
    for (const result of [
      update.result!.slice(0, update.result!.indexOf('</whycode-task-state>')),
      update.result!.replace('"items":[', '"items":[null,'),
      update.result!.replace('"evidence":[]', '"evidence":[{}]'),
      update.result!.replace('schema-version="1"', 'schema-version="2"'),
    ]) assert.equal(parseTaskToolResult({ ...update, result }), null)
  })

  it('每次调用的快照独立，后续计划变化不会回写历史', () => {
    const snapshot = state()
    const previous = parseTaskToolResult(call('UpdateTaskItem', snapshot))
    snapshot.activePlan!.goal = '新的任务目标'
    snapshot.activePlan!.items[1]!.outcome = '新的任务内容'
    const next = parseTaskToolResult(call('UpdateTaskItem', snapshot))
    assert.equal(previous?.plan?.goal, '让任务计划结果清晰可读')
    assert.equal(previous?.plan?.items[1]?.outcome, '完成计划展示')
    assert.equal(next?.plan?.goal, '新的任务目标')
  })
})
