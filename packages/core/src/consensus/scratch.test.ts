import assert from 'node:assert/strict'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createConsensusTaskScratch } from './scratch.ts'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })))
})

describe('协商临时工作区', () => {
  it('在会话 scratch 的 consensus 子树内隔离任务与 Agent', async () => {
    const sessionScratchDir = await mkdtemp(join(tmpdir(), 'whycode-consensus-scratch-'))
    tempRoots.push(sessionScratchDir)

    const scratch = await createConsensusTaskScratch(sessionScratchDir, 'task-1')

    assert.equal(scratch.taskDir, join(sessionScratchDir, 'consensus', 'task-1'))
    for (const agentId of ['Main', 'B', 'C'] as const) {
      assert.equal(scratch.agentDirs[agentId], join(scratch.taskDir, agentId))
      await access(scratch.agentDirs[agentId])
    }
  })
})
