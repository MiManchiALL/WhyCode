import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { localWorkspace, type SubagentManifest } from '@whycode/core'
import { SubagentStorage } from './subagent-storage.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('子代理独立持久化', () => {
  it('把 transcript 与 manifest 放在父会话目录内，并严格校验所有权', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-subagent-storage-'))
    roots.push(root)
    const sessionsRoot = join(root, 'sessions')
    const storage = new SubagentStorage(sessionsRoot)
    const parentSessionId = randomUUID()
    const journal = await storage.create(parentSessionId, {
      workspace: localWorkspace('C:\\workspace'),
      modelId: 'test:model',
    })
    await journal.recordUserInputWithId(randomUUID(), '调查调用链', true)
    const manifest = fixture(parentSessionId, journal.sessionId)
    await storage.writeManifest(manifest)

    assert.deepEqual(await storage.readManifest(parentSessionId, journal.sessionId), manifest)
    assert.deepEqual(await storage.listManifests(parentSessionId), [manifest])
    assert.equal((await storage.listAllManifests())[0]?.id, journal.sessionId)
    const directory = join(sessionsRoot, parentSessionId, 'subagents', journal.sessionId)
    await access(join(directory, 'subagent.json'))
    assert.match(await readFile(join(directory, 'transcript.jsonl'), 'utf8'), /调查调用链/)
    await assert.rejects(
      () => storage.readManifest(randomUUID(), journal.sessionId),
    )
  })
})

function fixture(parentSessionId: string, subagentId: string): SubagentManifest {
  const now = '2026-08-21T08:00:00.000Z'
  return {
    schemaVersion: 1,
    id: subagentId,
    parentSessionId,
    createdByTurnId: 'turn-1',
    createdByToolCallId: 'tool-1',
    definition: {
      id: 'explore',
      name: '探索代理',
      description: '只读调查',
      profile: 'explore',
      scope: 'builtin',
      instructions: '读取证据。',
      toolNames: ['ReadFile'],
    },
    modelId: 'test:model',
    reasoningEffort: 'default',
    permission: {
      mode: 'default',
      additionalDirs: [],
      sessionAllowedTools: [],
    },
    createdAt: now,
    updatedAt: now,
    activations: [{
      id: randomUUID(),
      sequence: 1,
      parentTurnId: 'turn-1',
      parentToolCallId: 'tool-1',
      promptPreview: '调查调用链',
      startedAt: now,
    }],
  }
}
