import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  pendingWorktreeRequest,
  pendingWorktreeWorkspace,
  workspaceDisplayDirectory,
} from './workspace.ts'

describe('工作区展示目录', () => {
  it('直接展示 Local，并从 Worktree 绑定推导实际子目录', () => {
    assert.equal(workspaceDisplayDirectory({ mode: 'none' }), null)
    assert.equal(workspaceDisplayDirectory({
      mode: 'local',
      workingDirectory: 'C:\\work\\local',
    }), 'C:\\work\\local')
    assert.equal(workspaceDisplayDirectory({
      mode: 'worktree',
      id: '11111111-1111-4111-8111-111111111111',
      repositoryDirectory: 'C:\\work\\source',
      worktreeDirectory: 'C:\\managed\\worktree',
      relativeWorkingDirectory: 'packages/desktop',
      baseCommit: '1'.repeat(40),
      baseRef: 'main',
      createdAt: '2026-07-31T01:02:03.000Z',
    }), 'C:\\managed\\worktree\\packages\\desktop')
  })

  it('待创建 Worktree 只展示来源目录，并可无损还原首条消息创建请求', () => {
    const request = {
      mode: 'worktree' as const,
      selectedDirectory: 'C:\\work\\source',
      baseRef: 'main',
      expectedBaseCommit: '2'.repeat(40),
      acknowledgeUncommittedChangesExcluded: true,
    }
    const pending = pendingWorktreeWorkspace(request)

    assert.equal(workspaceDisplayDirectory(pending), request.selectedDirectory)
    assert.deepEqual(pendingWorktreeRequest(pending), request)
  })
})
