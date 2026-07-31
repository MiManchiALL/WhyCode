import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { localWorkspace, type CoreEvent } from '@whycode/core'
import { pendingWorktreeWorkspace } from '../shared/workspace.ts'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'

describe('会话工作计时', () => {
  it('根工作只启动一次，并在终态前固定持续时间', () => {
    const events: CoreEvent[] = []
    const runtime = new DesktopSessionRuntime({
      workspace: localWorkspace('C:\\WhyCode'),
      modelId: 'test:model',
      emit: (_runtime, event) => events.push(event),
    })

    runtime.beginWork()
    const startedAt = runtime.workStartedAt
    runtime.beginWork()
    runtime.emit({ type: 'agent-status', status: 'working' }, false)
    runtime.emit({ type: 'agent-status', status: 'idle' }, false)

    assert.equal(typeof startedAt, 'number')
    assert.equal(events.filter((event) => event.type === 'work-started').length, 1)
    const finished = events.find((event) => event.type === 'work-finished')
    assert.ok(finished?.type === 'work-finished' && finished.durationMs >= 0)
    assert.ok(
      events.findIndex((event) => event.type === 'work-finished')
      < events.findIndex((event) => event.type === 'agent-status' && event.status === 'idle'),
    )
    assert.equal(runtime.workStartedAt, null)
  })

  it('交付异常可幂等结束工作计时', () => {
    const events: CoreEvent[] = []
    const runtime = new DesktopSessionRuntime({
      workspace: localWorkspace('C:\\WhyCode'),
      modelId: 'test:model',
      emit: (_runtime, event) => events.push(event),
    })

    runtime.beginWork()
    runtime.finishWork()
    runtime.finishWork()

    assert.equal(events.filter((event) => event.type === 'work-finished').length, 1)
    assert.equal(runtime.workStartedAt, null)
  })
})

describe('运行时 Worktree 状态转换', () => {
  it('首条消息前没有执行目录，绑定精确创建结果后才暴露 Worktree', () => {
    const runtimeId = '11111111-1111-4111-8111-111111111111'
    const baseCommit = '1'.repeat(40)
    const runtime = new DesktopSessionRuntime({
      runtimeId,
      workspace: pendingWorktreeWorkspace({
        mode: 'worktree',
        selectedDirectory: 'C:\\source',
        baseRef: 'main',
        expectedBaseCommit: baseCommit,
        acknowledgeUncommittedChangesExcluded: false,
      }),
      modelId: 'test:model',
      emit: () => {},
    })

    assert.equal(runtime.projectDir, null)
    assert.equal(runtime.workspaceBinding, null)
    runtime.bindPendingWorktree({
      mode: 'worktree',
      id: runtimeId,
      repositoryDirectory: 'C:\\source',
      worktreeDirectory: 'C:\\managed\\worktree',
      relativeWorkingDirectory: '.',
      baseCommit,
      baseRef: 'main',
      createdAt: '2026-08-01T00:00:00.000Z',
    })

    assert.equal(runtime.workspace.mode, 'worktree')
    assert.equal(runtime.projectDir, 'C:\\managed\\worktree')
  })

  it('拒绝绑定其它运行时或其它基线的创建结果', () => {
    const runtime = new DesktopSessionRuntime({
      runtimeId: '11111111-1111-4111-8111-111111111111',
      workspace: pendingWorktreeWorkspace({
        mode: 'worktree',
        selectedDirectory: 'C:\\source',
        baseRef: 'main',
        expectedBaseCommit: '1'.repeat(40),
        acknowledgeUncommittedChangesExcluded: false,
      }),
      modelId: null,
      emit: () => {},
    })

    assert.throws(() => runtime.bindPendingWorktree({
      mode: 'worktree',
      id: '22222222-2222-4222-8222-222222222222',
      repositoryDirectory: 'C:\\source',
      worktreeDirectory: 'C:\\managed\\other',
      relativeWorkingDirectory: '.',
      baseCommit: '1'.repeat(40),
      baseRef: 'main',
      createdAt: '2026-08-01T00:00:00.000Z',
    }), /创建结果与待创建 Worktree 选择不一致/)
    assert.equal(runtime.workspace.mode, 'pending-worktree')
  })
})
