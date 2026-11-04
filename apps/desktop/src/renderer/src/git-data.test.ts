import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { act, createElement, useReducer } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import type { GitComparison, GitSnapshot } from '../../shared/git.ts'
import type { SshConnectionStatus } from '../../shared/ssh.ts'
import type { WorkspaceActionResult } from '../../shared/workspace.ts'
import { GitRepository } from '../../main/git-repository.ts'
import { requireGitSuccess } from '../../main/git-process.ts'
import { readGitSnapshot } from '../../main/git-snapshot.ts'
import { useGitComparisonRecovery } from './git-comparison.ts'
import { defaultGitPage, RightPanelSessionStore, updateRightPanelPage, type GitPage, type RightPanelSessionState } from './right-panel-state.ts'
import { gitConnectionUnavailableReason, useGitSnapshot, type GitData } from './git-data.ts'

const snapshot: GitSnapshot = { status: 'not-repository', repository: null, changes: null, changesError: null }
const ready: GitSnapshot = { status: 'ready', repository: {
  root: '/project', name: 'project', branch: 'main', head: null, upstream: null, ahead: 0, behind: 0,
  refs: [], remotes: [], defaultBase: null, staged: 0, unstaged: 0, untracked: 0, conflicts: 0,
}, changes: null, changesError: null }

describe('Git 读取与 SSH 状态', () => {
  it('连接状态未就绪时不读取，刷新也不会连接服务器；连接完成后自动读取', async t => {
    const page = await gitFixture(t)
    await page.tick()
    assert.equal(page.requests.length, 0)
    for (const status of ['disconnected', 'connecting', 'interrupted', 'releasing', undefined] as const) {
      await page.render({ status, loading: false })
      assert.ok(page.current.unavailableReason)
      await act(async () => page.current.refresh())
      await page.tick()
      assert.equal(page.requests.length, 0)
    }
    await page.render({ status: 'connected' })
    await page.tick()
    assert.equal(page.requests.length, 1)
    await act(async () => page.requests[0]!.resolve({ ok: true, value: snapshot }))
    assert.equal(page.current.unavailableReason, null)
    assert.equal(page.current.loading, false)
    assert.equal(page.current.snapshot, snapshot)
  })

  it('断开连接使在途响应失效，重新连接后旧请求不能覆盖新结果', async t => {
    const page = await gitFixture(t)
    await page.render({ status: 'connected', loading: false })
    await page.tick()
    await page.render({ status: 'disconnected' })
    await act(async () => page.current.refresh())
    await page.tick()
    assert.equal(page.requests.length, 1)
    await page.render({ status: 'connected' })
    await page.tick()
    assert.equal(page.requests.length, 2)
    await act(async () => page.requests[1]!.resolve({ ok: true, value: snapshot }))
    await act(async () => page.requests[0]!.resolve({ ok: false, error: '旧连接已经断开' }))
    assert.equal(page.current.snapshot, snapshot)
    assert.equal(page.current.error, null)
    assert.equal(page.current.loading, false)
  })

  it('本地仓库仍直接读取，真实 Git 错误保留重试入口', async t => {
    const page = await gitFixture(t)
    await page.render({ remote: false })
    await page.tick()
    await act(async () => page.requests[0]!.resolve({ ok: false, error: '无权读取仓库' }))
    assert.equal(page.current.unavailableReason, null)
    assert.equal(page.current.error, '无权读取仓库')
    await act(async () => page.current.refresh())
    await page.tick()
    await act(async () => page.requests[1]!.resolve({ ok: true, value: snapshot }))
    assert.equal(page.current.error, null)
    assert.equal(page.current.snapshot, snapshot)
  })

  it('刷新立即进入等待状态，合并连续刷新并更新外部变更的分支列表', async t => {
    const page = await gitFixture(t)
    await page.render({ remote: false })
    await page.tick()
    const old: GitSnapshot = { ...ready, repository: { ...ready.repository,
      refs: [{ ref: 'refs/heads/deleted', name: 'deleted', remote: false }],
    } }
    await act(async () => page.requests[0]!.resolve({ ok: true, value: old }))
    await act(async () => page.current.refresh())
    assert.equal(page.current.loading, true)
    assert.equal(page.requests.length, 1)
    await act(async () => { page.current.refresh(); page.current.refresh() })
    await page.tick()
    assert.equal(page.requests.length, 2)
    await act(async () => page.requests[1]!.resolve({ ok: true, value: ready }))
    assert.deepEqual(page.current.snapshot?.repository?.refs, [])
    assert.equal(page.current.loading, false)
    await page.tick()
    assert.equal(page.requests.length, 2)
  })

  it('在途读取收到刷新后忽略旧结果，随后只追加一次读取', async t => {
    const page = await gitFixture(t)
    await page.render({ remote: false })
    await page.tick()
    await act(async () => { page.current.refresh(); page.current.refresh() })
    assert.equal(page.requests.length, 1)
    await act(async () => page.requests[0]!.resolve({ ok: true, value: snapshot }))
    assert.equal(page.current.snapshot, null)
    assert.equal(page.current.loading, true)
    assert.equal(page.requests.length, 2)
    await act(async () => page.requests[1]!.resolve({ ok: true, value: ready }))
    assert.equal(page.current.snapshot, ready)
    assert.equal(page.current.loading, false)
    await page.tick()
    assert.equal(page.requests.length, 2)
  })

  it('缺少 Git 清除旧仓库，重新检测成功后恢复；断线提示仍由 SSH 状态决定', async t => {
    const page = await gitFixture(t)
    await page.render({ status: 'connected', loading: false })
    await page.tick()
    await act(async () => page.requests[0]!.resolve({ ok: true, value: ready }))
    await act(async () => page.current.refresh())
    await page.tick()
    await act(async () => page.requests[1]!.resolve({ ok: true, value: { ...snapshot, status: 'git-not-found' } }))
    assert.equal(page.current.snapshot?.status, 'git-not-found')
    assert.equal(page.current.snapshot?.repository, null)
    assert.equal(page.current.error, null)
    assert.equal(page.current.unavailableReason, null)

    await act(async () => page.current.refresh())
    await page.tick()
    await act(async () => page.requests[2]!.resolve({ ok: true, value: ready }))
    assert.equal(page.current.snapshot, ready)
    await page.render({ status: 'disconnected' })
    assert.equal(page.current.unavailableReason, 'SSH 未连接，请先连接服务器')
    await act(async () => page.current.refresh())
    await page.tick()
    assert.equal(page.requests.length, 3)
  })
})

describe('Git 比较基准校正', () => {
  it('变更页未挂载时，实际已删除的引用自动回到未提交，刷新和持久恢复不再读取旧引用', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'whycode-git-comparison-'))
    t.after(async () => {
      assert.equal(dirname(directory), resolve(tmpdir()))
      await rm(directory, { recursive: true, force: true })
    })
    const repo = new GitRepository(directory)
    for (const args of [['init', '-b', 'main'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'initial'],
      ['update-ref', 'refs/remotes/origin/review', 'HEAD'], ['update-ref', '-d', 'refs/remotes/origin/review']]) {
      requireGitSuccess(await repo.run(args, { readOnly: false }), '准备测试仓库')
    }
    const baseRef = 'refs/remotes/origin/review'
    const failed = await readGitSnapshot(Promise.resolve(repo), { mode: 'branch', baseRef })
    const recovered = await readGitSnapshot(Promise.resolve(repo), { mode: 'branch', baseRef: null })
    assert.ok(failed.repository)
    assert.ok(failed.changesError)
    assert.ok(recovered.repository)
    assert.equal(recovered.changesError, null)
    const initial = panelWithGit({ baseRef })
    const page = await gitFixture(t, { runtime: initial })
    await page.render({ remote: false })
    await page.tick()
    assert.deepEqual(page.requests[0]!.comparison, { mode: 'branch', baseRef })
    await act(async () => page.requests[0]!.resolve({ ok: true, value: failed }))
    await page.tick()
    assert.deepEqual(page.requests[1]!.comparison, { mode: 'branch', baseRef: null })
    await act(async () => page.requests[1]!.resolve({ ok: true, value: recovered }))
    const expected = { ...initial, tabs: initial.tabs.map(tab => tab.page.kind === 'git'
      ? { ...tab, page: { ...tab.page, mode: 'uncommitted', baseRef: null } } : tab) }
    assert.deepEqual(page.restored().get('runtime'), expected)
    assert.equal(page.current.snapshot?.changesError, null)
    await act(async () => page.current.refresh())
    await page.tick()
    assert.deepEqual(page.requests[2]!.comparison, { mode: 'branch', baseRef: null })
    await act(async () => page.requests[2]!.resolve({ ok: true, value: recovered }))
    await page.tick()
    assert.equal(page.requests.length, 3)
  })

  it('基准被删除后优先使用有效跟踪分支，不展开侧栏或切走当前标签', async t => {
    const upstream = 'refs/remotes/origin/main'
    const repository = { ...ready.repository, upstream, defaultBase: upstream,
      refs: [{ ref: upstream, name: 'origin/main', remote: true }] }
    const initial = { ...panelWithGit({ baseRef: 'refs/heads/deleted' }), open: true }
    const page = await gitFixture(t, { runtime: initial })
    await page.render({ remote: false })
    await page.tick()
    await act(async () => page.requests[0]!.resolve({ ok: true, value: { ...ready, repository, changesError: '比较基准不存在' } }))
    const saved = page.restored().get('runtime')
    assert.equal(saved.open, true)
    assert.equal(saved.activeTabId, 'workspace')
    assert.deepEqual(saved.tabs[1], initial.tabs[1])
    assert.deepEqual(saved.tabs[0]!.page, { ...initial.tabs[0]!.page, baseRef: upstream })
    await page.tick()
    assert.deepEqual(page.requests[1]!.comparison, { mode: 'branch', baseRef: upstream })
    await act(async () => page.requests[1]!.resolve({ ok: true, value: { ...ready, repository } }))
    await page.tick()
    assert.equal(page.requests.length, 2)
  })

  it('其它比较范围也清理失效基准，保留范围、提交与文件选择', async t => {
    const modes = ['uncommitted', 'unstaged', 'staged', 'commit'] as const
    const states = Object.fromEntries(modes.map(mode => [mode, panelWithGit({ mode, baseRef: 'refs/heads/deleted',
      commit: 'a'.repeat(40), expandedPaths: ['file.ts'], selectedPath: 'file.ts' })]))
    const page = await gitFixture(t, states)
    for (const mode of modes) {
      await page.render({ remote: false, runtimeId: mode })
      await page.tick()
      await act(async () => page.requests.at(-1)!.resolve({ ok: true, value: { ...ready, changesError: '比较基准不存在' } }))
      assert.deepEqual(page.restored().get(mode).tabs[0]!.page, { ...states[mode]!.tabs[0]!.page, baseRef: null })
      await page.tick()
      assert.deepEqual(page.requests.at(-1)!.comparison, { mode: 'branch', baseRef: null })
      await act(async () => page.requests.at(-1)!.resolve({ ok: true, value: ready }))
    }
  })

  it('有效基准的读取错误保留重试；刷新发现基准成为当前分支时才重新选择', async t => {
    const baseRef = 'refs/heads/review'
    const repository = { ...ready.repository, defaultBase: 'refs/heads/main',
      refs: [{ ref: baseRef, name: 'review', remote: false }, { ref: 'refs/heads/main', name: 'main', remote: false }] }
    const initial = panelWithGit({ baseRef })
    const page = await gitFixture(t, { runtime: initial })
    await page.render({ remote: false })
    await page.tick()
    await act(async () => page.requests[0]!.resolve({ ok: true, value: { ...ready, repository, changesError: '读取变更清单超时' } }))
    assert.equal(page.current.snapshot?.changesError, '读取变更清单超时')
    assert.deepEqual(page.restored().get('runtime'), initial)
    await page.tick()
    assert.equal(page.requests.length, 1)
    await act(async () => page.current.refresh())
    await page.tick()
    await act(async () => page.requests[1]!.resolve({ ok: false, error: '无权读取仓库' }))
    assert.equal(page.current.error, '无权读取仓库')
    assert.deepEqual(page.restored().get('runtime'), initial)
    await act(async () => page.current.refresh())
    await page.tick()
    await act(async () => page.requests[2]!.resolve({ ok: true, value: { ...ready,
      repository: { ...repository, branch: 'review', defaultBase: baseRef } } }))
    assert.deepEqual(page.restored().get('runtime').tabs[0]!.page, { ...defaultGitPage(), mode: 'uncommitted' })
    await page.tick()
    await act(async () => page.requests[3]!.resolve({ ok: true, value: ready }))
    assert.equal(page.current.error, null)
  })

  it('切换会话后迟到响应不改写选择，返回原会话时按新结果独立校正', async t => {
    const first = panelWithGit({ baseRef: 'refs/heads/deleted' })
    const second = panelWithGit({ baseRef: 'refs/heads/other' })
    const page = await gitFixture(t, { first, second })
    await page.render({ remote: false, runtimeId: 'first' })
    await page.tick()
    await page.render({ runtimeId: 'second' })
    await page.tick()
    await act(async () => page.requests[0]!.resolve({ ok: true, value: ready }))
    assert.deepEqual(page.restored().get('first'), first)
    assert.deepEqual(page.restored().get('second'), second)
    assert.equal(page.current.snapshot, null)
    await act(async () => page.requests[1]!.resolve({ ok: true, value: { ...ready, repository: { ...ready.repository,
      refs: [{ ref: 'refs/heads/other', name: 'other', remote: false }] } } }))
    await page.render({ runtimeId: 'first' })
    await page.tick()
    await act(async () => page.requests[2]!.resolve({ ok: true, value: ready }))
    await page.tick()
    assert.equal(page.requests[3]!.runtimeId, 'first')
    assert.deepEqual(page.requests[3]!.comparison, { mode: 'branch', baseRef: null })
    await act(async () => page.requests[3]!.resolve({ ok: true, value: ready }))
    assert.equal(page.restored().get('first').open, false)
    assert.deepEqual(page.restored().get('second'), second)
  })
})

function panelWithGit(page: Partial<GitPage>): RightPanelSessionState {
  return { open: false, inspectorView: 'plan', activeTabId: 'workspace', tabs: [
    { id: 'git', page: { ...defaultGitPage(), ...page } }, { id: 'workspace', page: { kind: 'workspace', expanded: [] } },
  ] }
}

async function gitFixture(t: TestContext, panels: Record<string, RightPanelSessionState> = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { window, document } = parseHTML('<html><body></body></html>')
  const requests: Array<{ runtimeId: string; comparison: GitComparison; resolve: (result: WorkspaceActionResult<GitSnapshot>) => void }> = []
  Object.defineProperty(window, 'whycode', { configurable: true, value: {
    gitSnapshot: (runtimeId: string, comparison: GitComparison) => new Promise<WorkspaceActionResult<GitSnapshot>>(resolve => requests.push({ runtimeId, comparison, resolve })),
  } })
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true }
  const originals = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  const root = createRoot(document.body)
  t.after(async () => {
    await act(async () => root.unmount())
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const store = new RightPanelSessionStore(storage)
  for (const [key, state] of Object.entries(panels)) store.set(key, state)
  const options: { status: SshConnectionStatus | undefined; loading: boolean; remote: boolean; runtimeId: string } = {
    status: undefined, loading: true, remote: true, runtimeId: 'runtime',
  }
  let current!: GitData
  function GitView() {
    const [, render] = useReducer(value => value + 1, 0)
    const runtimeId = options.runtimeId
    const page = store.get(runtimeId).tabs.find(tab => tab.page.kind === 'git')?.page
    current = useGitSnapshot(runtimeId, page?.kind === 'git' ? { mode: 'branch', baseRef: page.baseRef } : { mode: 'uncommitted' }, options.status ?? '', true,
      options.remote ? gitConnectionUnavailableReason(options.status, options.loading) : null)
    useGitComparisonRecovery(page?.kind === 'git' ? page : undefined, current, page => {
      store.set(runtimeId, updateRightPanelPage(store.get(runtimeId), page))
      render()
    })
    return null
  }
  const render = (patch: Partial<typeof options>) => act(async () => {
    Object.assign(options, patch)
    root.render(createElement(GitView))
  })
  await render({})
  return { get current() { return current }, requests, render, restored: () => new RightPanelSessionStore(storage),
    tick: () => act(async () => t.mock.timers.tick(120)) }
}
