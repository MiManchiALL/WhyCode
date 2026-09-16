import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { CheckpointManager } from './manager.ts'
import { CHECKPOINT_FILE_PREVIEW_MAX_BYTES } from './types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('持久化资源检查点', () => {
  it('回答摘要按所选检查点的首尾状态计算，后续写入和回滚不改写历史', async () => {
    const env = await createEnvironment()
    const path = join(env.project, 'summary.ts')
    const other = join(env.project, 'other.ts')
    await writeFile(path, 'original\n')
    const first = await change('first', [path, other], ['original\n1\n2\n3\n4\n5\n', 'other\n'])
    const second = await change('second', [path], ['original\n'])
    const last = await change('last', [path], ['replacement\n'])
    assert.deepEqual(await env.manager.fileChanges([first.id, second.id]), [{ path: other, added: 1, removed: 0 }])
    assert.deepEqual(await env.manager.fileChanges([second.id, first.id, first.id]), [{ path: other, added: 1, removed: 0 }])
    assert.deepEqual(await env.manager.fileChanges([first.id, last.id]), [
      { path, added: 1, removed: 1 }, { path: other, added: 1, removed: 0 },
    ])
    assert.deepEqual(await env.manager.fileChanges([last.id]), [{ path, added: 1, removed: 1 }])
    assert.equal((await env.manager.restore('first', 'files')).ok, true)
    assert.deepEqual(await env.manager.fileChanges([first.id, second.id]), [{ path: other, added: 1, removed: 0 }])
    assert.deepEqual(await managerFor(env).fileChanges([last.id]), [{ path, added: 1, removed: 1 }])
    await assert.rejects(env.manager.fileChanges([randomUUID()]), /检查点不可用/)
    await assert.rejects(env.manager.fileChanges(['../outside']), /无效检查点/)

    async function change(toolUseId: string, paths: string[], contents: string[]) {
      const prepared = await env.manager.prepare(toolUseId, toolUseId, { kind: 'exact-files', paths })
      assert.ok(prepared)
      await Promise.all(paths.map((path, index) => writeFile(path, contents[index]!)))
      const ready = await env.manager.finalize(prepared)
      assert.ok(ready)
      return ready
    }
  })

  it('同一 turn 比较首次 before 与最新 after，追加后删回原样不留下净变化', async () => {
    const env = await createEnvironment()
    const path = join(env.project, 'net.ts')
    const original = 'original\n'
    await writeFile(path, original)
    assert.deepEqual(await change(path, original + '1\n2\n3\n4\n5\n'), [
      { path, added: 5, removed: 0 },
    ])
    assert.deepEqual(await change(path, original), [null])
    assert.deepEqual(await change(path, 'replacement\n'), [{ path, added: 1, removed: 1 }])
    assert.deepEqual(await change(path, 'another\n'), [{ path, added: 1, removed: 1 }])
    assert.deepEqual(await change(path, original), [null])

    async function change(path: string, content: string) {
      const prepared = await env.manager.prepare(randomUUID(), 'turn-1', {
        kind: 'exact-files', paths: [path],
      })
      assert.ok(prepared)
      await writeFile(path, content)
      const ready = await env.manager.finalize(prepared)
      assert.ok(ready)
      return [...(await env.manager.turnFileChanges(ready)).values()]
    }
  })

  it('新建后删除归零，原文件删除后重建归零；空文件创建仍计为文件变化', async () => {
    const env = await createEnvironment()
    const path = join(env.project, 'lifecycle.ts')
    const initial = await env.manager.prepare('create', 'turn-1', { kind: 'exact-files', paths: [path] })
    assert.ok(initial)
    await writeFile(path, '')
    const created = await env.manager.finalize(initial)
    assert.ok(created)
    assert.deepEqual([...(await env.manager.turnFileChanges(created)).values()], [
      { path, added: 0, removed: 0 },
    ])
    const deletion = await env.manager.prepare('delete', 'turn-1', { kind: 'exact-files', paths: [path] })
    assert.ok(deletion)
    await rm(path)
    const deleted = await env.manager.finalize(deletion)
    assert.ok(deleted)
    assert.deepEqual([...(await env.manager.turnFileChanges(deleted)).values()], [null])

    await writeFile(path, 'before\n')
    const remove = await env.manager.prepare('remove', 'turn-2', { kind: 'exact-files', paths: [path] })
    assert.ok(remove)
    await rm(path)
    const removed = await env.manager.finalize(remove)
    assert.ok(removed)
    assert.deepEqual([...(await env.manager.turnFileChanges(removed)).values()], [{ path, added: 0, removed: 1 }])
    const recreate = await env.manager.prepare('recreate', 'turn-2', { kind: 'exact-files', paths: [path] })
    assert.ok(recreate)
    await writeFile(path, 'before\n')
    const recreated = await env.manager.finalize(recreate)
    assert.ok(recreated)
    assert.deepEqual([...(await env.manager.turnFileChanges(recreated)).values()], [null])
  })

  it('不同 turn 重新建立基线，只返回本次落盘路径且不读取后来改变的工作区正文', async () => {
    const env = await createEnvironment()
    const paths = ['a.ts', 'b.ts'].map(name => join(env.project, name))
    const first = await env.manager.prepare('first', 'turn-1', { kind: 'exact-files', paths })
    assert.ok(first)
    await Promise.all(paths.map(path => writeFile(path, 'first\n')))
    assert.ok(await env.manager.finalize(first))
    const path = paths[0]!
    const second = await env.manager.prepare('second', 'turn-2', { kind: 'exact-files', paths: [path] })
    assert.ok(second)
    await writeFile(path, 'second\n')
    const ready = await env.manager.finalize(second)
    assert.ok(ready)
    await writeFile(path, 'external\nchange\n')
    assert.deepEqual([...(await env.manager.turnFileChanges(ready)).values()], [
      { path, added: 1, removed: 1 },
    ])
  })

  it('二进制或过大的正文不生成伪造的精确行数', async () => {
    const env = await createEnvironment()
    const paths = ['binary', 'large'].map(name => join(env.project, name))
    const prepared = await env.manager.prepare('bounded', 'turn-1', { kind: 'exact-files', paths })
    assert.ok(prepared)
    await writeFile(paths[0]!, Buffer.from([0, 1, 2]))
    await writeFile(paths[1]!, 'x'.repeat(CHECKPOINT_FILE_PREVIEW_MAX_BYTES + 1))
    const ready = await env.manager.finalize(prepared)
    assert.ok(ready)
    assert.deepEqual([...(await env.manager.turnFileChanges(ready)).values()], [null, null])
  })

  it('按工具和文件读取精确前后版本，检查点失效后仍可用于历史预览', async () => {
    const env = await createEnvironment()
    const path = join(env.project, 'preview.ts')
    await writeFile(path, 'const value = 1\n')
    const prepared = await env.manager.prepare('tool-preview', 'turn-1', {
      kind: 'exact-files', paths: [path],
    })
    assert.ok(prepared)
    await writeFile(path, 'const value = 2\n')
    assert.ok(await env.manager.finalize(prepared))

    assert.deepEqual(await env.manager.filePreview('tool-preview', path), {
      path,
      before: { kind: 'text', content: 'const value = 1\n', size: 16 },
      after: { kind: 'text', content: 'const value = 2\n', size: 16 },
    })
    assert.equal(await env.manager.filePreviewMatchesCurrent('tool-preview', path), true)
    assert.equal(await env.manager.filePreview('tool-preview', join(env.project, 'other.ts')), null)
    assert.equal(
      await env.manager.filePreviewMatchesCurrent('tool-preview', join(env.project, 'other.ts')),
      null,
    )

    await writeFile(path, 'const value = 3\n')
    assert.equal(await env.manager.filePreviewMatchesCurrent('tool-preview', path), false)
    await writeFile(path, 'const value = 2\n')

    assert.equal((await env.manager.restore('tool-preview', 'files')).ok, true)
    assert.equal((await env.manager.filePreview('tool-preview', path))?.after.kind, 'text')
  })

  it('只按检查点拥有的原路径读取当前文件，不追踪移动或删除后的身份', async () => {
    const env = await createEnvironment()
    const path = join(env.project, 'current.ts')
    await writeFile(path, 'before')
    const prepared = await env.manager.prepare('tool-current', 'turn-1', {
      kind: 'exact-files', paths: [path],
    })
    assert.ok(prepared)
    await writeFile(path, 'snapshot')
    assert.ok(await env.manager.finalize(prepared))

    await writeFile(path, 'latest on disk')
    assert.deepEqual(await env.manager.currentFilePreview(path), {
      kind: 'text', content: 'latest on disk', size: 14,
    })

    const movedPath = join(env.project, 'moved.ts')
    await rename(path, movedPath)
    assert.deepEqual(await env.manager.currentFilePreview(path), { kind: 'missing' })
    assert.equal(await env.manager.currentFilePreview(movedPath), null)
    const unownedPath = join(env.external, 'not-owned.ts')
    await writeFile(unownedPath, 'must stay private')
    assert.equal(await env.manager.currentFilePreview(unownedPath), null)
  })

  it('当前文件读取沿用二进制与实际大小硬限制', async () => {
    const env = await createEnvironment()
    const path = join(env.project, 'bounded.dat')
    await writeFile(path, 'before')
    const prepared = await env.manager.prepare('tool-current-bounds', 'turn-1', {
      kind: 'exact-files', paths: [path],
    })
    assert.ok(prepared)
    await writeFile(path, 'snapshot')
    assert.ok(await env.manager.finalize(prepared))

    await writeFile(path, Buffer.from([1, 0, 2]))
    assert.deepEqual(await env.manager.currentFilePreview(path), {
      kind: 'unavailable', reason: 'binary', size: 3,
    })

    const size = CHECKPOINT_FILE_PREVIEW_MAX_BYTES + 1
    await writeFile(path, Buffer.alloc(size, 97))
    assert.deepEqual(await env.manager.currentFilePreview(path), {
      kind: 'unavailable', reason: 'too-large', size,
    })
  })

  it('文件预览拒绝把二进制 blob 送入界面', async () => {
    const env = await createEnvironment()
    const path = join(env.project, 'binary.dat')
    await writeFile(path, Buffer.from([1, 0, 2]))
    const prepared = await env.manager.prepare('tool-binary', 'turn-1', {
      kind: 'exact-files', paths: [path],
    })
    assert.ok(prepared)
    await writeFile(path, Buffer.from([3, 0, 4]))
    assert.ok(await env.manager.finalize(prepared))

    const preview = await env.manager.filePreview('tool-binary', path)
    assert.deepEqual(preview?.before, { kind: 'unavailable', reason: 'binary', size: 3 })
    assert.deepEqual(preview?.after, { kind: 'unavailable', reason: 'binary', size: 3 })
  })

  it('文件预览在读取正文前按实际 blob 大小执行硬上限', async () => {
    const env = await createEnvironment()
    const path = join(env.project, 'large.txt')
    const size = CHECKPOINT_FILE_PREVIEW_MAX_BYTES + 1
    await writeFile(path, Buffer.alloc(size, 97))
    const prepared = await env.manager.prepare('tool-large', 'turn-1', {
      kind: 'exact-files', paths: [path],
    })
    assert.ok(prepared)
    await writeFile(path, 'small')
    assert.ok(await env.manager.finalize(prepared))

    const preview = await env.manager.filePreview('tool-large', path)
    assert.deepEqual(preview?.before, { kind: 'unavailable', reason: 'too-large', size })
    assert.deepEqual(preview?.after, { kind: 'text', content: 'small', size: 5 })
  })

  it('新建与删除工具的预览保留文件不存在这一侧的精确状态', async () => {
    const env = await createEnvironment()
    const createdPath = join(env.project, 'created.txt')
    const create = await env.manager.prepare('tool-create-preview', 'turn-1', {
      kind: 'exact-files', paths: [createdPath],
    })
    assert.ok(create)
    await writeFile(createdPath, 'created')
    assert.ok(await env.manager.finalize(create))
    const created = await env.manager.filePreview('tool-create-preview', createdPath)
    assert.deepEqual(created?.before, { kind: 'missing' })
    assert.deepEqual(created?.after, { kind: 'text', content: 'created', size: 7 })

    const deletePath = join(env.project, 'deleted.txt')
    await writeFile(deletePath, 'deleted')
    const remove = await env.manager.prepare('tool-delete-preview', 'turn-2', {
      kind: 'exact-files', paths: [deletePath],
    })
    assert.ok(remove)
    await rm(deletePath)
    assert.ok(await env.manager.finalize(remove))
    const deleted = await env.manager.filePreview('tool-delete-preview', deletePath)
    assert.deepEqual(deleted?.before, { kind: 'text', content: 'deleted', size: 7 })
    assert.deepEqual(deleted?.after, { kind: 'missing' })
    assert.equal(
      await env.manager.filePreviewMatchesCurrent('tool-delete-preview', deletePath),
      true,
    )
    await writeFile(deletePath, 'recreated')
    assert.equal(
      await env.manager.filePreviewMatchesCurrent('tool-delete-preview', deletePath),
      false,
    )
  })

  it('移动工具可按目标路径读取操作后的文件快照', async () => {
    const env = await createEnvironment()
    const source = join(env.project, 'before-name.txt')
    const destination = join(env.project, 'after-name.txt')
    await writeFile(source, 'moved content')
    const prepared = await env.manager.prepare('tool-move-preview', 'turn-1', {
      kind: 'exact-files', paths: [source, destination],
    })
    assert.ok(prepared)
    await rename(source, destination)
    assert.ok(await env.manager.finalize(prepared))

    assert.deepEqual(await env.manager.filePreview('tool-move-preview', destination), {
      path: destination,
      before: { kind: 'missing' },
      after: { kind: 'text', content: 'moved content', size: 13 },
    })
    assert.equal(
      await env.manager.filePreviewMatchesCurrent('tool-move-preview', destination),
      true,
    )
  })

  it('一个检查点完整恢复同批删除的多个文件', async () => {
    const env = await createEnvironment()
    const first = join(env.project, 'first.txt')
    const second = join(env.project, 'second.txt')
    await Promise.all([
      writeFile(first, 'first content'),
      writeFile(second, 'second content'),
    ])

    const prepared = await env.manager.prepare('tool-delete-many', 'turn-1', {
      kind: 'exact-files',
      paths: [first, second],
    })
    assert.ok(prepared)
    await Promise.all([rm(first), rm(second)])
    assert.ok(await env.manager.finalize(prepared))

    const restored = await env.manager.restore('tool-delete-many', 'files')
    assert.equal(restored.ok, true, restored.error)
    assert.equal(await readFile(first, 'utf8'), 'first content')
    assert.equal(await readFile(second, 'utf8'), 'second content')
  })

  it('精确撤销项目外新建文件，并清理本次新建的空父目录', async () => {
    const env = await createEnvironment()
    const path = join(env.external, 'new-parent', 'created.txt')
    const prepared = await env.manager.prepare('tool-create', 'turn-1', {
      kind: 'exact-files',
      paths: [path],
    })
    assert.ok(prepared, env.manager.disabled ?? '精确文件检查点准备失败')
    await mkdir(join(env.external, 'new-parent'))
    await writeFile(path, 'agent content')
    assert.ok(await env.manager.finalize(prepared))

    const restored = await env.manager.restore('tool-create', 'files')
    assert.equal(restored.ok, true, restored.error)
    await assert.rejects(access(path))
    await assert.rejects(access(join(env.external, 'new-parent')))
  })

  it('用户在 Agent 之后修改文件时拒绝覆盖，且不破坏当前内容', async () => {
    const env = await createEnvironment()
    const path = join(env.external, 'existing.txt')
    await writeFile(path, 'before')
    const prepared = await env.manager.prepare('tool-edit', 'turn-1', {
      kind: 'exact-files',
      paths: [path],
    })
    assert.ok(prepared)
    await writeFile(path, 'agent')
    assert.ok(await env.manager.finalize(prepared))
    await writeFile(path, 'user changed later')

    const checked = await env.manager.checkRestore('tool-edit', 'files')
    assert.equal(checked.ok, false)
    assert.match(checked.error ?? '', /又被修改/)
    assert.equal(await readFile(path, 'utf8'), 'user changed later')

    const restored = await env.manager.restore('tool-edit', 'files')
    assert.equal(restored.ok, false)
    assert.match(restored.error ?? '', /又被修改/)
    assert.equal(await readFile(path, 'utf8'), 'user changed later')
  })

  it('二次确认前的检查只读验证冲突，不提前恢复或使检查点失效', async () => {
    const env = await createEnvironment()
    const path = join(env.external, 'confirm.txt')
    await writeFile(path, 'before')
    const prepared = await env.manager.prepare('tool-confirm', 'turn-1', {
      kind: 'exact-files', paths: [path],
    })
    assert.ok(prepared)
    await writeFile(path, 'agent')
    assert.ok(await env.manager.finalize(prepared))

    const checked = await env.manager.checkRestore('tool-confirm', 'files')
    assert.equal(checked.ok, true, checked.error)
    assert.equal(await readFile(path, 'utf8'), 'agent')
    assert.ok(await env.manager.getReady('tool-confirm'))

    const restored = await env.manager.restore('tool-confirm', 'files')
    assert.equal(restored.ok, true, restored.error)
    assert.equal(await readFile(path, 'utf8'), 'before')
  })

  it('撤销较早操作时按相反顺序撤销同一会话的后续写入', async () => {
    const env = await createEnvironment()
    const path = join(env.project, '.env.local')
    await writeFile(path, 'original')

    const first = await env.manager.prepare('tool-1', 'turn-1', {
      kind: 'exact-files', paths: [path],
    })
    assert.ok(first)
    await writeFile(path, 'first')
    assert.ok(await env.manager.finalize(first))

    const second = await env.manager.prepare('tool-2', 'turn-2', {
      kind: 'exact-files', paths: [path],
    })
    assert.ok(second)
    await writeFile(path, 'second')
    assert.ok(await env.manager.finalize(second))

    const restored = await env.manager.restore('tool-1', 'files')
    assert.equal(restored.ok, true)
    assert.deepEqual(restored.invalidatedToolUseIds, ['tool-1', 'tool-2'])
    assert.equal(await readFile(path, 'utf8'), 'original')
  })

  it('重新创建 Manager 后仍能从会话 manifest 恢复', async () => {
    const env = await createEnvironment()
    const path = join(env.external, 'restart.txt')
    await writeFile(path, 'before restart')
    const prepared = await env.manager.prepare('tool-restart', 'turn-1', {
      kind: 'exact-files', paths: [path],
    })
    assert.ok(prepared)
    await writeFile(path, 'after restart')
    assert.ok(await env.manager.finalize(prepared))

    const reopened = managerFor(env)
    const restored = await reopened.restore('tool-restart', 'files')
    assert.equal(restored.ok, true)
    assert.equal(await readFile(path, 'utf8'), 'before restart')
  })

  it('对话事务提交失败时补偿文件，并保留检查点供再次恢复', async () => {
    const env = await createEnvironment()
    const path = join(env.external, 'transaction.txt')
    await writeFile(path, 'before')
    const prepared = await env.manager.prepare('tool-transaction', 'turn-1', {
      kind: 'exact-files', paths: [path],
    })
    assert.ok(prepared)
    await writeFile(path, 'agent')
    assert.ok(await env.manager.finalize(prepared))

    const failed = await env.manager.restore('tool-transaction', 'files-and-chat', {
      commit: async () => { throw new Error('会话日志写入失败') },
      compensate: async () => {},
    })
    assert.equal(failed.ok, false)
    assert.equal(await readFile(path, 'utf8'), 'agent')
    assert.ok(await env.manager.getReady('tool-transaction'))

    const retried = await env.manager.restore('tool-transaction', 'files')
    assert.equal(retried.ok, true)
    assert.equal(await readFile(path, 'utf8'), 'before')
  })

  it('命令屏障允许精确文件恢复，但禁止同时截断对话', async () => {
    const env = await createEnvironment()
    const path = join(env.external, 'barrier.txt')
    await writeFile(path, 'before')
    const prepared = await env.manager.prepare('tool-covered', 'turn-1', {
      kind: 'exact-files', paths: [path],
    })
    assert.ok(prepared)
    await writeFile(path, 'agent')
    assert.ok(await env.manager.finalize(prepared))
    await env.manager.recordBarrier('tool-unknown', 'turn-2', '未知写操作')

    const chatCheck = await env.manager.checkRestore('tool-covered', 'files-and-chat')
    assert.equal(chatCheck.ok, false)
    assert.match(chatCheck.error ?? '', /只能回滚专用文件工具跟踪的文件/)
    assert.equal(await readFile(path, 'utf8'), 'agent')

    const chatRestore = await env.manager.restore('tool-covered', 'files-and-chat')
    assert.equal(chatRestore.ok, false)
    assert.match(chatRestore.error ?? '', /只能回滚专用文件工具跟踪的文件/)

    const fileRestore = await env.manager.restore('tool-covered', 'files')
    assert.equal(fileRestore.ok, true, fileRestore.error)
    assert.equal(await readFile(path, 'utf8'), 'before')
  })
})

interface TestEnvironment {
  root: string
  project: string
  external: string
  sessionDir: string
  sessionId: string
  manager: CheckpointManager
}

async function createEnvironment(): Promise<TestEnvironment> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-checkpoints-'))
  roots.push(root)
  const project = join(root, 'project')
  const external = join(root, 'external')
  const sessionDir = join(root, 'session-checkpoints')
  await Promise.all([mkdir(project), mkdir(external)])
  const env = {
    root,
    project,
    external,
    sessionDir,
    sessionId: randomUUID(),
  }
  return { ...env, manager: managerFor(env) }
}

function managerFor(env: Omit<TestEnvironment, 'manager'>): CheckpointManager {
  return new CheckpointManager({
    sessionDir: env.sessionDir,
    sessionId: env.sessionId,
  })
}
