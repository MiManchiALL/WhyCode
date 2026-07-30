import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'
import {
  localWorkspace,
  workspaceBindingSchema,
  workspaceWorkingDirectory,
} from './types.ts'

describe('WorkspaceBinding', () => {
  it('从唯一绑定事实推导 Local、无目录与 Worktree 执行目录', () => {
    assert.equal(workspaceWorkingDirectory(localWorkspace(null)), null)
    assert.equal(
      workspaceWorkingDirectory(localWorkspace('C:\\work\\local')),
      'C:\\work\\local',
    )

    const worktree = workspaceBindingSchema.parse({
      mode: 'worktree',
      id: '11111111-1111-4111-8111-111111111111',
      repositoryDirectory: process.cwd(),
      worktreeDirectory: process.cwd(),
      relativeWorkingDirectory: 'packages/core',
      baseCommit: '1'.repeat(40),
      baseRef: 'main',
      createdAt: '2026-07-31T01:02:03.000Z',
    })
    assert.equal(
      workspaceWorkingDirectory(worktree),
      resolve(process.cwd(), 'packages', 'core'),
    )
  })

  it('拒绝会越过受管 Worktree 的非规范相对目录', () => {
    for (const relativeWorkingDirectory of [
      '',
      '..',
      '../outside',
      'packages/../outside',
      '/absolute',
      'C:/absolute',
      'packages\\core',
      'packages//core',
      'packages/D:/outside',
      'packages/.. /outside',
      'packages/name./outside',
    ]) {
      assert.equal(workspaceBindingSchema.safeParse({
        mode: 'worktree',
        id: '11111111-1111-4111-8111-111111111111',
        repositoryDirectory: process.cwd(),
        worktreeDirectory: process.cwd(),
        relativeWorkingDirectory,
        baseCommit: '1'.repeat(40),
        baseRef: null,
        createdAt: '2026-07-31T01:02:03.000Z',
      }).success, false)
    }
  })
})
