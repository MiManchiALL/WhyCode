import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Block } from './conversation-state.ts'
import {
  HEART_WAVE_FLOW_SPAN,
  HEART_WAVE_LOOP_SECONDS,
  HEART_WAVE_PATH,
} from './heart-wave.ts'
import { shouldShowThinkingGap } from './thinking-gap.ts'

const user: Block = { kind: 'user', id: 'user-1', text: '开始' }
const completedTool: Block = {
  kind: 'tool',
  id: 'tool-1',
  call: {
    id: 'call-1',
    name: 'ReadFile',
    input: {},
    status: 'done',
    progress: '',
  },
}

function visible(blocks: readonly Block[], overrides: Partial<{
  status: 'idle' | 'thinking' | 'working' | 'waiting-approval' | 'error'
  stopping: boolean
  workStartedAt: number | null
}> = {}): boolean {
  return shouldShowThinkingGap({
    blocks,
    status: overrides.status ?? 'working',
    stopping: overrides.stopping ?? false,
    workStartedAt: overrides.workStartedAt === undefined ? 1 : overrides.workStartedAt,
  })
}

describe('模型空窗反馈', () => {
  it('首条消息提交后和工具结束后显示', () => {
    assert.equal(visible([user]), true)
    assert.equal(visible([user, completedTool]), true)
    assert.equal(visible([
      user,
      { kind: 'thinking', id: 'thinking-1', text: '分析', durationMs: 320 },
    ]), true)
  })

  it('运行中工具、流式思考和正文输出使用各自反馈', () => {
    assert.equal(visible([
      user,
      {
        ...completedTool,
        call: { ...completedTool.call, status: 'running' },
      },
    ]), false)
    assert.equal(visible([
      user,
      { kind: 'thinking', id: 'thinking-1', text: '分析', durationMs: null },
    ]), false)
    assert.equal(visible([
      user,
      { kind: 'text', id: 'text-1', text: '正在输出', phase: 'pending' },
    ]), false)
  })

  it('任一并行工具仍在运行时不与工具转圈重复', () => {
    assert.equal(visible([
      user,
      {
        ...completedTool,
        id: 'tool-running',
        call: { ...completedTool.call, id: 'call-running', status: 'running' },
      },
      completedTool,
    ]), false)
  })

  it('非工作状态、停止中和没有活动任务时隐藏', () => {
    assert.equal(visible([user], { status: 'waiting-approval' }), false)
    assert.equal(visible([user], { status: 'idle' }), false)
    assert.equal(visible([user], { stopping: true }), false)
    assert.equal(visible([user], { workStartedAt: null }), false)
  })

  it('只读取最近一次工作区段', () => {
    const oldRunningTool: Block = {
      ...completedTool,
      id: 'old-tool',
      call: { ...completedTool.call, id: 'old-call', status: 'running' },
    }
    assert.equal(visible([
      { kind: 'user', id: 'old-user', text: '旧任务' },
      oldRunningTool,
      {
        kind: 'work-duration',
        id: 'duration-1',
        forkTurnId: null,
        durationMs: 10,
        outcome: 'stopped',
      },
      user,
    ]), true)
  })

  it('Heart Wave 使用细分路径和单段连续流动线', () => {
    assert.equal((HEART_WAVE_PATH.match(/[ML]/g) ?? []).length, 481)
    assert.equal(HEART_WAVE_LOOP_SECONDS, 3)
    assert.equal(HEART_WAVE_FLOW_SPAN, 18)
    assert.ok(HEART_WAVE_FLOW_SPAN > 0 && HEART_WAVE_FLOW_SPAN < 100)
    assert.match(HEART_WAVE_PATH, /^M\d+\.\d{2},\d+\.\d{2}/)
  })
})
