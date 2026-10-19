import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import type { GitSnapshot } from '../../shared/git.ts'
import type { SshConnectionStatus } from '../../shared/ssh.ts'
import type { WorkspaceActionResult } from '../../shared/workspace.ts'
import { gitConnectionUnavailableReason, useGitSnapshot, type GitData } from './git-data.ts'

const snapshot: GitSnapshot = { status: 'not-repository', repository: null, changes: null, changesError: null }

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

  it('缺少 Git 清除旧仓库，重新检测成功后恢复；断线提示仍由 SSH 状态决定', async t => {
    const page = await gitFixture(t)
    await page.render({ status: 'connected', loading: false })
    await page.tick()
    const ready: GitSnapshot = { status: 'ready', repository: {
      root: '/project', name: 'project', branch: 'main', head: null, upstream: null, ahead: 0, behind: 0,
      refs: [], remotes: [], defaultBase: null, staged: 0, unstaged: 0, untracked: 0, conflicts: 0,
    }, changes: null, changesError: null }
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

async function gitFixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { window, document } = parseHTML('<html><body></body></html>')
  const requests: Array<{ resolve: (result: WorkspaceActionResult<GitSnapshot>) => void }> = []
  Object.defineProperty(window, 'whycode', { configurable: true, value: {
    gitSnapshot: () => new Promise<WorkspaceActionResult<GitSnapshot>>(resolve => requests.push({ resolve })),
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
  const options: { status: SshConnectionStatus | undefined; loading: boolean; remote: boolean } = {
    status: undefined, loading: true, remote: true,
  }
  let current!: GitData
  function GitView() {
    current = useGitSnapshot('runtime', { mode: 'uncommitted' }, options.status ?? '', true,
      options.remote ? gitConnectionUnavailableReason(options.status, options.loading) : null)
    return null
  }
  const render = (patch: Partial<typeof options>) => act(async () => {
    Object.assign(options, patch)
    root.render(createElement(GitView))
  })
  await render({})
  return { get current() { return current }, requests, render, tick: () => act(async () => t.mock.timers.tick(120)) }
}
