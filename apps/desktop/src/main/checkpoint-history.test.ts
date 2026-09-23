import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { CheckpointManager, SessionStore, localWorkspace } from '@whycode/core'
import {
  checkCheckpointFileCurrentMatch,
  readCheckpointFileChanges,
  readCheckpointFilePreview,
} from './checkpoint-history.ts'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'

describe('历史文件检查点读取', () => {
  it('项目与其它交付文件排在临时文件前，保留各组顺序且不误判同名前缀目录', async (t) => {
    const f = await setup(t)
    const scratch = join(f.root, 'scratch')
    const tempDirectory = join(scratch, f.journal.sessionId, 'Main')
    const outsideDirectory = join(f.root, 'scratch-other')
    await Promise.all([mkdir(tempDirectory, { recursive: true }), mkdir(outsideDirectory)])
    const paths = [join(tempDirectory, 'first.py'), join(f.root, 'report.txt'),
      join(tempDirectory, 'second.py'), join(outsideDirectory, 'outside.txt'), join(f.root, 'notes.txt')]
    const manager = new CheckpointManager({ sessionId: f.journal.sessionId, sessionDir: f.journal.checkpointDirectory })
    const pending = await manager.prepare('mixed', 'turn-3', { kind: 'exact-files', paths })
    assert.ok(pending)
    await Promise.all(paths.map(path => writeFile(path, '内容')))
    const checkpoint = await manager.finalize(pending)
    assert.ok(checkpoint)
    const runtime = newRuntime()
    runtime.journal = await f.store.open(f.journal.sessionId)
    const result = await readCheckpointFileChanges(runtime, [checkpoint.id], scratch)
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.changes.map(change => change.path), [paths[1], paths[3], paths[4], paths[0], paths[2]])
    assert.equal(runtime.session, null)
  })

  it('冷恢复且模型不可用时仍展示新建与编辑快照，无需创建 Agent 或再次发言', async (t) => {
    const f = await setup(t)
    const transcript = join(f.root, 'sessions', f.journal.sessionId, 'transcript.jsonl')
    const before = await readFile(transcript, 'utf8')
    const runtime = newRuntime()
    runtime.journal = await f.store.open(f.journal.sessionId)
    assert.equal(runtime.session, null)
    assert.deepEqual(await readCheckpointFileChanges(runtime, [f.created.id], join(f.root, 'scratch')), {
      ok: true, changes: [{ path: f.path, added: 1, removed: 0 }],
    })
    assert.deepEqual(await readCheckpointFileChanges(runtime, [f.edited.id], join(f.root, 'scratch')), {
      ok: true, changes: [{ path: f.path, added: 1, removed: 1 }],
    })
    assert.deepEqual(await readCheckpointFilePreview(runtime, 'create', f.path), {
      ok: true, preview: { path: f.path, before: { kind: 'missing' }, after: { kind: 'text', content: 'A', size: 1 } },
    })
    assert.deepEqual(await readCheckpointFilePreview(runtime, 'edit', f.path), {
      ok: true, preview: { path: f.path, before: { kind: 'text', content: 'A', size: 1 }, after: { kind: 'text', content: 'B', size: 1 } },
    })
    assert.deepEqual(await readCheckpointFilePreview(runtime, [f.edited.id, f.created.id, f.created.id], f.path), {
      ok: true, preview: { path: f.path, before: { kind: 'missing' }, after: { kind: 'text', content: 'B', size: 1 } },
    })
    assert.deepEqual(await checkCheckpointFileCurrentMatch(runtime, 'create', f.path), { ok: true, matches: false })
    assert.deepEqual(await checkCheckpointFileCurrentMatch(runtime, 'edit', f.path), { ok: true, matches: true })
    await writeFile(f.path, '外部修改')
    assert.deepEqual(await readCheckpointFilePreview(runtime, [f.created.id, f.edited.id], f.path), {
      ok: true, preview: { path: f.path, before: { kind: 'missing' }, after: { kind: 'text', content: 'B', size: 1 } },
    })
    assert.deepEqual(await checkCheckpointFileCurrentMatch(runtime, 'edit', f.path), { ok: true, matches: false })
    assert.equal(runtime.session, null)
    assert.equal(await readFile(transcript, 'utf8'), before)
  })

  it('缺少记录或已卸载的运行时给出真实错误，不能误报缺少文件检查点', async (t) => {
    const f = await setup(t)
    const disposed = newRuntime()
    disposed.journal = f.journal
    await disposed.dispose()
    for (const runtime of [null, newRuntime(), disposed]) {
      const results = await Promise.all([
        readCheckpointFileChanges(runtime, [f.created.id], join(f.root, 'scratch')),
        readCheckpointFilePreview(runtime, 'create', f.path),
        checkCheckpointFileCurrentMatch(runtime, 'create', f.path),
      ])
      for (const result of results) {
        assert.equal(result.ok, false)
        if (!result.ok) assert.match(result.error, /会话记录不可用/)
      }
    }
  })

  it('保留检查点归属、路径和损坏校验，不把真实读取失败隐藏为空改动', async (t) => {
    const f = await setup(t)
    const runtime = newRuntime()
    runtime.journal = f.journal
    const other = newRuntime()
    other.journal = await f.store.create({ workspace: localWorkspace(null), modelId: 'unavailable:model' })
    assert.equal((await readCheckpointFileChanges(other, [f.created.id], join(f.root, 'scratch'))).ok, false)
    assert.equal((await readCheckpointFilePreview(other, 'create', f.path)).ok, false)
    assert.equal((await readCheckpointFilePreview(other, [f.created.id], f.path)).ok, false)
    assert.equal((await readCheckpointFilePreview(runtime, ['../outside'], f.path)).ok, false)
    assert.equal((await readCheckpointFileChanges(runtime, ['../outside'], join(f.root, 'scratch'))).ok, false)
    assert.equal((await readCheckpointFileChanges(runtime, [randomUUID()], join(f.root, 'scratch'))).ok, false)
    const outside = join(f.root, 'outside.txt')
    await writeFile(outside, '不属于该检查点')
    assert.equal((await readCheckpointFilePreview(runtime, 'create', outside)).ok, false)
    assert.equal((await readCheckpointFilePreview(runtime, [f.created.id, f.edited.id], outside)).ok, false)
    assert.equal((await checkCheckpointFileCurrentMatch(runtime, 'create', outside)).ok, false)
    await writeFile(join(f.journal.checkpointDirectory, 'manifests', `${f.created.id}.json`), '损坏数据')
    const damaged = await readCheckpointFileChanges(runtime, [f.created.id], join(f.root, 'scratch'))
    assert.equal(damaged.ok, false)
    if (!damaged.ok) assert.match(damaged.error, /文件改动读取失败/)
  })
})

function newRuntime() {
  return new DesktopSessionRuntime({ workspace: localWorkspace(null), modelId: 'unavailable:model', emit: () => {} })
}

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-checkpoint-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  const path = join(project, 'A.txt')
  const store = new SessionStore(join(root, 'sessions'))
  const journal = await store.create({ workspace: localWorkspace(project), modelId: 'unavailable:model' })
  const manager = new CheckpointManager({ sessionId: journal.sessionId, sessionDir: journal.checkpointDirectory })
  const first = await manager.prepare('create', 'turn-1', { kind: 'exact-files', paths: [path] })
  assert.ok(first)
  await writeFile(path, 'A')
  const created = await manager.finalize(first)
  assert.ok(created)
  const second = await manager.prepare('edit', 'turn-2', { kind: 'exact-files', paths: [path] })
  assert.ok(second)
  await writeFile(path, 'B')
  const edited = await manager.finalize(second)
  assert.ok(edited)
  return { root, path, store, journal, created, edited }
}
