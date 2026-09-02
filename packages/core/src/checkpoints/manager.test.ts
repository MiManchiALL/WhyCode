import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { CheckpointManager } from './manager.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('持久化资源检查点', () => {
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
