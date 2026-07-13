import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { simpleGit } from 'simple-git'
import { CheckpointManager } from './manager.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('持久化资源检查点', () => {
  it('精确撤销项目外新建文件，并清理本次新建的空父目录', async () => {
    const env = await createEnvironment()
    const path = join(env.external, 'new-parent', 'created.txt')
    const prepared = await env.manager.prepare('tool-create', 'turn-1', {
      kind: 'exact-files',
      paths: [path],
    })
    assert.ok(prepared, env.manager.disabled ?? '树检查点准备失败')
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

    const restored = await env.manager.restore('tool-edit', 'files')
    assert.equal(restored.ok, false)
    assert.match(restored.error ?? '', /又被修改/)
    assert.equal(await readFile(path, 'utf8'), 'user changed later')
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

  it('后续存在未覆盖写操作时阻止旧检查点越界恢复', async () => {
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

    const restored = await env.manager.restore('tool-covered', 'files')
    assert.equal(restored.ok, false)
    assert.match(restored.error ?? '', /未覆盖的写操作/)
    assert.equal(await readFile(path, 'utf8'), 'agent')
  })

  it('树快照只恢复命令实际改变的受控路径，并标注部分覆盖', async () => {
    const env = await createEnvironment()
    await simpleGit(env.project).init()
    const modified = join(env.project, 'modified.txt')
    const deleted = join(env.project, 'deleted.txt')
    const untouched = join(env.project, 'untouched.txt')
    const created = join(env.project, 'created.txt')
    await Promise.all([
      writeFile(modified, 'before modified'),
      writeFile(deleted, 'before deleted'),
      writeFile(untouched, 'stay'),
    ])
    const prepared = await env.manager.prepare('tool-command', 'turn-1', {
      kind: 'workspace-roots',
      roots: [env.project],
      warning: '命令影响范围无法完全证明',
    })
    assert.ok(prepared, env.manager.disabled ?? '树检查点准备失败')
    await Promise.all([
      writeFile(modified, 'after modified'),
      rm(deleted),
      writeFile(created, 'created'),
    ])
    const ready = await env.manager.finalize(prepared)
    assert.equal(ready?.coverage, 'partial')

    const restored = await env.manager.restore('tool-command', 'files')
    assert.equal(restored.ok, true, restored.error)
    assert.equal(await readFile(modified, 'utf8'), 'before modified')
    assert.equal(await readFile(deleted, 'utf8'), 'before deleted')
    assert.equal(await readFile(untouched, 'utf8'), 'stay')
    await assert.rejects(access(created))
    await access(join(env.project, '.git'))
  })

  it('树回滚只捕获变更路径，不重新扫描无关超大文件', async () => {
    const env = await createEnvironment()
    const target = join(env.project, 'target.txt')
    await writeFile(target, 'before')
    const prepared = await env.manager.prepare('tool-scoped-restore', 'turn-1', {
      kind: 'workspace-roots',
      roots: [env.project],
      warning: '命令影响范围无法完全证明',
    })
    assert.ok(prepared, env.manager.disabled ?? '树检查点准备失败')
    await writeFile(target, 'after')
    assert.ok(await env.manager.finalize(prepared))

    const unrelated = join(env.project, 'unrelated.csv')
    await writeFile(unrelated, '')
    await truncate(unrelated, 65 * 1024 * 1024)

    const restored = await env.manager.restore('tool-scoped-restore', 'files')
    assert.equal(restored.ok, true, restored.error)
    assert.equal(await readFile(target, 'utf8'), 'before')
    await access(unrelated)
  })

  it('命令只影响被拒绝的大范围目录时明确说明没有可回滚文件', async () => {
    const env = await createEnvironment()
    const desktop = join(homedir(), 'Desktop')
    const prepared = await env.manager.prepare('tool-uncovered', 'turn-1', {
      kind: 'workspace-roots',
      roots: [env.project, desktop],
      warning: '命令影响范围无法完全证明',
    })
    assert.ok(prepared)

    assert.equal(await env.manager.finalize(prepared), null)
    assert.match(env.manager.disabled ?? '', /未进入可回滚范围/)
    assert.match(env.manager.disabled ?? '', /Desktop/)
  })
})

interface TestEnvironment {
  root: string
  project: string
  external: string
  storage: string
  sessionDir: string
  sessionId: string
  manager: CheckpointManager
}

async function createEnvironment(): Promise<TestEnvironment> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-checkpoints-'))
  roots.push(root)
  const project = join(root, 'project')
  const external = join(root, 'external')
  const storage = join(root, 'shadow')
  const sessionDir = join(root, 'session-checkpoints')
  await Promise.all([mkdir(project), mkdir(external)])
  const env = {
    root,
    project,
    external,
    storage,
    sessionDir,
    sessionId: randomUUID(),
  }
  return { ...env, manager: managerFor(env) }
}

function managerFor(env: Omit<TestEnvironment, 'manager'>): CheckpointManager {
  return new CheckpointManager({
    projectDir: env.project,
    storageRoot: env.storage,
    sessionDir: env.sessionDir,
    sessionId: env.sessionId,
  })
}
