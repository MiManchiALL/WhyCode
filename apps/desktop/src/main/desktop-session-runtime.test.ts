import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { localWorkspace, type CoreEvent } from '@whycode/core'
import { pendingManagedWorkspace, pendingWorktreeWorkspace } from '../shared/workspace.ts'
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
    runtime.emit({
      type: 'turn-end',
      turnId: 'turn-completed',
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0 },
      stopReason: 'completed',
    }, false)
    runtime.emit({ type: 'agent-status', status: 'idle' }, false)

    assert.equal(typeof startedAt, 'number')
    assert.equal(events.filter((event) => event.type === 'work-started').length, 1)
    const finished = events.find((event) => event.type === 'work-finished')
    assert.ok(finished?.type === 'work-finished' && finished.durationMs >= 0)
    assert.equal(finished?.type === 'work-finished' && finished.outcome, 'completed')
    assert.equal(finished?.type === 'work-finished' && finished.forkTurnId, 'turn-completed')
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

  it('用户停止与宿主关闭使用不同的工作终态', async () => {
    const events: CoreEvent[] = []
    const runtime = new DesktopSessionRuntime({
      workspace: localWorkspace('C:\\WhyCode'),
      modelId: 'test:model',
      emit: (_runtime, event) => events.push(event),
    })

    runtime.beginWork()
    await runtime.abort('user')
    runtime.emit({ type: 'agent-status', status: 'idle' }, false)
    const stopped = events.find((event) => event.type === 'work-finished')
    assert.equal(stopped?.type === 'work-finished' && stopped.outcome, 'stopped')
    assert.equal(stopped?.type === 'work-finished' && stopped.forkTurnId, null)

    runtime.beginWork()
    await runtime.abort('shutdown')
    runtime.emit({ type: 'agent-status', status: 'idle' }, false)
    const finished = events.filter((event) => event.type === 'work-finished').at(-1)
    assert.equal(finished?.type === 'work-finished' && finished.outcome, 'completed')
  })

  it('暂停或等待用户的模型回复不成为 Fork 边界', () => {
    const events: CoreEvent[] = []
    const runtime = new DesktopSessionRuntime({
      workspace: localWorkspace('C:\\WhyCode'),
      modelId: 'test:model',
      emit: (_runtime, event) => events.push(event),
    })

    runtime.beginWork()
    runtime.emit({
      type: 'turn-end',
      turnId: 'turn-waiting',
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0 },
      stopReason: 'waiting-user',
    }, false)
    runtime.emit({ type: 'agent-status', status: 'idle' }, false)

    const finished = events.find((event) => event.type === 'work-finished')
    assert.equal(finished?.type === 'work-finished' && finished.forkTurnId, null)
  })

  it('后续执行异常会清除先前的完整回复边界', () => {
    const events: CoreEvent[] = []
    const runtime = new DesktopSessionRuntime({
      workspace: localWorkspace('C:\\WhyCode'),
      modelId: 'test:model',
      emit: (_runtime, event) => events.push(event),
    })

    runtime.beginWork()
    runtime.emit({
      type: 'turn-end',
      turnId: 'turn-before-error',
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0 },
      stopReason: 'completed',
    }, false)
    runtime.emit({ type: 'agent-status', status: 'error' }, false)

    const finished = events.find((event) => event.type === 'work-finished')
    assert.equal(finished?.type === 'work-finished' && finished.forkTurnId, null)
  })

  it('协作或宿主错误事件同样会废弃先前的 Fork 边界', () => {
    const events: CoreEvent[] = []
    const runtime = new DesktopSessionRuntime({
      workspace: localWorkspace('C:\\WhyCode'),
      modelId: 'test:model',
      emit: (_runtime, event) => events.push(event),
    })

    runtime.beginWork()
    runtime.emit({
      type: 'turn-end',
      turnId: 'turn-before-core-error',
      usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0 },
      stopReason: 'completed',
    }, false)
    runtime.emit({ type: 'error', message: '后续协作失败', recoverable: true }, false)
    runtime.emit({ type: 'agent-status', status: 'idle' }, false)

    const finished = events.find((event) => event.type === 'work-finished')
    assert.equal(finished?.type === 'work-finished' && finished.forkTurnId, null)
  })

  it('BTW 使用独立终点，并在排队 Main 真正开始时重建计时', () => {
    const events: CoreEvent[] = []
    const runtime = new DesktopSessionRuntime({
      workspace: localWorkspace('C:\\WhyCode'),
      modelId: 'test:model',
      emit: (_runtime, event) => events.push(event),
    })

    runtime.beginBtwWork()
    runtime.emit({ type: 'agent-status', status: 'idle' }, false)
    assert.equal(events.some((event) => event.type === 'work-finished'), false)

    runtime.finishBtwWork(125, 'completed', true)
    const finished = events.find((event) => event.type === 'work-finished')
    assert.deepEqual(finished, {
      type: 'work-finished',
      durationMs: 125,
      outcome: 'completed',
      forkTurnId: null,
    })
    assert.equal(events.filter((event) => event.type === 'work-started').length, 2)
    assert.equal(typeof runtime.workStartedAt, 'number')
  })
})

describe('会话授权入口', () => {
  const request = {
    requestId: '11111111-1111-4111-8111-111111111111',
    toolName: 'RunCommand',
    input: { command: 'pnpm test' },
    reason: '需要确认',
  }

  it('全自动档不产生授权事件，并自动通过任何残留中的请求', async () => {
    const events: CoreEvent[] = []
    const runtime = new DesktopSessionRuntime({
      workspace: localWorkspace('C:\\WhyCode'),
      modelId: 'test:model',
      emit: (_runtime, event) => events.push(event),
    })

    const pending = runtime.requestApproval(request)
    assert.equal(runtime.approval?.requestId, request.requestId)
    runtime.setPermissionMode('auto')

    assert.deepEqual(await pending, { approved: true })
    assert.equal(runtime.approval, null)
    assert.deepEqual(await runtime.requestApproval({ ...request, requestId: 'next' }), {
      approved: true,
    })
    assert.equal(events.filter((event) => event.type === 'approval-request').length, 1)
  })

  it('切入只读档会拒绝并清空旧档位下仍在等待的授权', async () => {
    const events: CoreEvent[] = []
    const runtime = new DesktopSessionRuntime({
      workspace: localWorkspace('C:\\WhyCode'),
      modelId: 'test:model',
      emit: (_runtime, event) => events.push(event),
    })

    const pending = runtime.requestApproval(request)
    assert.equal(runtime.approval?.requestId, request.requestId)
    runtime.setPermissionMode('readonly')

    assert.deepEqual(await pending, { approved: false })
    assert.equal(runtime.approval, null)
    assert.equal(events.filter((event) => event.type === 'approval-request').length, 1)
  })

  it('默认与自动编辑档不会替用户处理仍在等待的授权', async () => {
    const runtime = new DesktopSessionRuntime({
      workspace: localWorkspace('C:\\WhyCode'),
      modelId: 'test:model',
      emit: () => {},
    })

    const pending = runtime.requestApproval(request)
    runtime.setPermissionMode('acceptEdits')
    assert.equal(runtime.approval?.requestId, request.requestId)
    assert.equal(runtime.respondApproval(request.requestId, { approved: false }), true)
    assert.deepEqual(await pending, { approved: false })
  })
})

describe('上下文用量运行态', () => {
  it('保存最新 Core 估算并允许模型切换时清空', () => {
    const runtime = new DesktopSessionRuntime({
      workspace: localWorkspace('C:\\WhyCode'),
      modelId: 'test:model',
      emit: () => {},
    })
    const usage = {
      usedTokens: 12_000,
      contextWindow: 100_000,
      autoCompactThreshold: 80_000,
      breakdown: {
        systemPromptTokens: 1_000,
        toolTokens: 2_000,
        messageTokens: 9_000,
      },
    }

    runtime.emit({ type: 'context-usage', usage })
    assert.deepEqual(runtime.contextUsage, usage)
    runtime.emit({ type: 'context-usage', usage: null })
    assert.equal(runtime.contextUsage, null)
  })
})

describe('运行时 Worktree 状态转换', () => {
  it('默认草稿在首条消息前只展示计划路径，绑定后才成为可执行目录', () => {
    const runtimeId = '11111111-1111-4111-8111-111111111111'
    const directory = `C:\\WhyCode Workspace\\${runtimeId}`
    const runtime = new DesktopSessionRuntime({
      runtimeId,
      workspace: pendingManagedWorkspace(runtimeId, directory),
      modelId: null,
      emit: () => {},
    })

    assert.equal(runtime.projectDir, null)
    runtime.bindPendingManaged({
      mode: 'managed',
      id: runtimeId,
      workingDirectory: directory,
      createdAt: '2026-08-05T00:00:00.000Z',
    })
    assert.equal(runtime.projectDir, directory)
  })

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
