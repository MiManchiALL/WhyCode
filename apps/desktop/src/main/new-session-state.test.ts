import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it } from 'node:test'
import { NewSessionStateStore } from './new-session-state.ts'
import { ManagedWorkspaceManager } from './workspace.ts'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { SessionRuntimeRegistry } from './session-runtime-registry.ts'

const id = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'

it('新会话目录跨重新初始化保持不变，首次提交后才释放入口', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'whycode-new-draft-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'new-session.json')
  const store = new NewSessionStateStore(path)
  await store.initialize()
  assert.equal(store.value, null)
  const state = { runtimeId: id, workspace: {
    mode: 'pending-managed' as const, id, workingDirectory: join(root, id),
  } }
  await store.set(state)
  const restored = new NewSessionStateStore(path)
  await restored.initialize()
  assert.deepEqual(restored.value, state)
  await restored.consume(secondId)
  assert.deepEqual(restored.value, state)
  await restored.consume(id)
  const restarted = new NewSessionStateStore(path)
  await restarted.initialize()
  assert.equal(restarted.value, null)
})

it('旧会话完成提交不能清掉并发准备的下一份新草稿', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'whycode-new-draft-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new NewSessionStateStore(join(root, 'new-session.json'))
  await store.set({ runtimeId: id, workspace: { mode: 'none' } })
  await Promise.all([
    store.set({ runtimeId: secondId, workspace: { mode: 'local', workingDirectory: root } }),
    store.consume(id),
  ])
  assert.equal(store.value?.runtimeId, secondId)
})

it('保存失败保留上一份目录身份，损坏内容明确拒绝恢复', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'whycode-new-draft-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'new-session.json')
  const store = new NewSessionStateStore(path)
  await store.set({ runtimeId: id, workspace: { mode: 'none' } })
  const previous = await readFile(path, 'utf8')
  await assert.rejects(store.set({ runtimeId: '../outside', workspace: { mode: 'none' } }))
  assert.equal(store.value?.runtimeId, id)
  assert.equal(await readFile(path, 'utf8'), previous)
  await writeFile(path, '{')
  await assert.rejects(new NewSessionStateStore(path).initialize())
})

it('新会话物化的默认目录重启后仍归草稿所有，发送后的目录不能冒充草稿', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'whycode-new-draft-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'work'))
  const manager = new ManagedWorkspaceManager(join(root, 'work'), join(root, 'manifests'))
  assert.equal(await manager.restoreDraft(id), null)
  const binding = await manager.create(id)
  await writeFile(join(binding.workingDirectory, 'keep.txt'), 'draft terminal output')
  const restarted = new ManagedWorkspaceManager(join(root, 'work'), join(root, 'manifests'))
  await restarted.cleanupAbandoned(new Set([id]))
  assert.deepEqual(await restarted.restoreDraft(id), binding)
  assert.equal(await readFile(join(binding.workingDirectory, 'keep.txt'), 'utf8'), 'draft terminal output')
  await restarted.attachSession(binding, secondId)
  await assert.rejects(restarted.restoreDraft(id), /已经属于/)
})

it('可返回的新草稿在切换及空闲后保留，被替换的旧草稿按原生命周期释放', async (t) => {
  let retained = id
  const registry = new SessionRuntimeRegistry({ idleUnloadMs: 1,
    retainDraft: (runtime) => runtime.runtimeId === retained,
  })
  t.after(() => registry.closeAll())
  const runtime = (runtimeId: string) => new DesktopSessionRuntime({
    runtimeId, workspace: { mode: 'none' }, modelId: null, emit: () => {},
  })
  const draft = runtime(id)
  const other = runtime(secondId)
  registry.select(draft)
  registry.select(other)
  assert.equal(await registry.removeUnselectedDraft(draft), false)
  registry.runtimeBecameIdle(draft)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(registry.get(id), draft)
  registry.select(draft)
  assert.equal(registry.selected, draft)
  registry.select(other)
  retained = secondId
  assert.equal(await registry.removeUnselectedDraft(draft), true)
  assert.equal(registry.get(id), null)
})
