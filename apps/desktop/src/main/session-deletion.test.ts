import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { CommandSessionManager, localWorkspace } from '@whycode/core'
import { deleteSessionArtifacts } from './session-deletion.ts'
import { DesktopSessionRepository } from './session-repository.ts'
import { SessionScratchManager } from './session-scratch.ts'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('会话关联数据删除', () => {
  it('级联清理目标会话，但保留同项目另一会话和项目文件', async () => {
    const root = await createRoot()
    const project = join(root, 'project')
    const sessionsRoot = join(root, 'sessions')
    const commandsRoot = join(root, 'command-tasks')
    const scratchRoot = join(root, 'scratch')
    await mkdir(project)
    const projectFile = join(project, 'keep.txt')
    await writeFile(projectFile, 'user data')

    const sessions = new DesktopSessionRepository(sessionsRoot)
    const deletedJournal = await sessions.create(localWorkspace(project), 'test:model')
    const currentJournal = await sessions.create(localWorkspace(project), 'test:model')
    const commandSessions = new CommandSessionManager(commandsRoot)
    const scratch = new SessionScratchManager(scratchRoot)
    await commandSessions.initialize()
    await mkdir(join(commandsRoot, deletedJournal.sessionId), { recursive: true })
    await writeFile(join(commandsRoot, deletedJournal.sessionId, 'old.log'), 'command output')
    await mkdir(join(scratchRoot, deletedJournal.sessionId, 'consensus', 'task', 'Main'), { recursive: true })
    await writeFile(
      join(scratchRoot, deletedJournal.sessionId, 'consensus', 'task', 'Main', 'probe.txt'),
      'scratch',
    )
    await mkdir(join(deletedJournal.checkpointDirectory, 'blobs'), { recursive: true })
    await writeFile(join(deletedJournal.checkpointDirectory, 'blobs', 'local'), 'checkpoint')
    const currentCommandFile = join(commandsRoot, currentJournal.sessionId, 'keep.log')
    const currentScratchFile = join(scratchRoot, currentJournal.sessionId, 'Main', 'keep.txt')
    const currentCheckpointFile = join(currentJournal.checkpointDirectory, 'blobs', 'keep')
    await mkdir(join(commandsRoot, currentJournal.sessionId), { recursive: true })
    await writeFile(currentCommandFile, 'other command')
    await mkdir(join(scratchRoot, currentJournal.sessionId, 'Main'), { recursive: true })
    await writeFile(currentScratchFile, 'other scratch')
    await mkdir(join(currentJournal.checkpointDirectory, 'blobs'), { recursive: true })
    await writeFile(currentCheckpointFile, 'other checkpoint')

    assert.equal(await deleteSessionArtifacts({
      sessionId: deletedJournal.sessionId,
      sessions,
      commandSessions,
      scratch,
    }), true)

    await assert.rejects(access(join(sessionsRoot, deletedJournal.sessionId)))
    await assert.rejects(access(join(commandsRoot, deletedJournal.sessionId)))
    await assert.rejects(access(join(scratchRoot, deletedJournal.sessionId)))
    await access(join(sessionsRoot, currentJournal.sessionId, 'transcript.jsonl'))
    assert.equal(await readFile(currentCommandFile, 'utf8'), 'other command')
    assert.equal(await readFile(currentScratchFile, 'utf8'), 'other scratch')
    assert.equal(await readFile(currentCheckpointFile, 'utf8'), 'other checkpoint')
    assert.equal(await readFile(projectFile, 'utf8'), 'user data')
  })

  it('先校验会话 ID，非法输入不会触发任何清理', async () => {
    const calls: string[] = []
    await assert.rejects(
      deleteSessionArtifacts({
        sessionId: '../outside',
        sessions: {
          markDeleting: async () => { calls.push('mark'); return true },
          delete: async () => { calls.push('session'); return true },
        },
        commandSessions: { removeSession: async () => { calls.push('command') } },
        scratch: { remove: async () => { calls.push('scratch') } },
      }),
      /无效会话 ID/,
    )
    assert.deepEqual(calls, [])
  })

  it('前置清理失败时持久标成仅可重试删除', async () => {
    const root = await createRoot()
    const sessions = new DesktopSessionRepository(join(root, 'sessions'))
    const journal = await sessions.create(localWorkspace(null), 'test:model')
    const scratch = new SessionScratchManager(join(root, 'scratch'))
    await assert.rejects(
      deleteSessionArtifacts({
        sessionId: journal.sessionId,
        sessions,
        commandSessions: { removeSession: async () => { throw new Error('日志被占用') } },
        scratch,
      }),
      /日志被占用/,
    )
    const [summary] = await sessions.list()
    assert.equal(summary?.sessionId, journal.sessionId)
    assert.equal(summary?.resumable, false)
    assert.match(summary?.unavailableReason ?? '', /删除未完成.*重试删除/)
  })

  it('在删除会话事实源前完成引用型显示元数据收尾', async () => {
    const calls: string[] = []
    assert.equal(await deleteSessionArtifacts({
      sessionId: '11111111-1111-4111-8111-111111111111',
      sessions: {
        markDeleting: async () => { calls.push('mark'); return true },
        delete: async () => { calls.push('session'); return true },
      },
      commandSessions: { removeSession: async () => { calls.push('command') } },
      scratch: { remove: async () => { calls.push('scratch') } },
      onDeletionMarked: async () => {
        calls.push('detach')
        await new Promise((resolve) => setImmediate(resolve))
        calls.push('resources-closed')
      },
      onBeforeFactSourceDelete: async () => { calls.push('references') },
    }), true)
    assert.deepEqual(
      calls,
      ['mark', 'detach', 'resources-closed', 'command', 'scratch', 'references', 'session'],
    )
  })
})

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-session-delete-'))
  tempRoots.push(root)
  return root
}
