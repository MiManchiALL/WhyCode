import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import type { SkillCatalogSnapshot } from '@whycode/core/skills'
import { createComposerCommands, useSkillComposer } from './use-skill-composer.ts'

describe('输入框功能命令目录', () => {
  it('没有对话消息时仍可查看 MCP 状态，不提供压缩命令', () => {
    assert.deepEqual(createComposerCommands({
      compactAvailable: false,
      compactDisabled: false,
      forkAvailable: false,
      forkDisabled: false,
    }).map((command) => command.id), ['mcp'])
  })

  it('已有对话时提供压缩命令，并保留运行态禁用标记', () => {
    assert.deepEqual(createComposerCommands({
      compactAvailable: true,
      compactDisabled: true,
      forkAvailable: true,
      forkDisabled: false,
    }).filter((command) => command.id !== 'mcp'), [{
      id: 'fork',
      name: '在新对话中继续',
      description: '从最近一次完整模型回复创建独立对话',
      keywords: ['fork', 'branch', '分支'],
      disabled: false,
    }, {
      id: 'compact',
      name: '压缩',
      description: '压缩当前会话上下文，释放上下文空间',
      keywords: ['compact', 'context'],
      disabled: true,
    }])
  })

  it('会话运行时不把 Fork 命令放进斜杠菜单', () => {
    assert.deepEqual(createComposerCommands({
      compactAvailable: true,
      compactDisabled: true,
      forkAvailable: false,
      forkDisabled: false,
    }).filter((command) => command.id !== 'mcp'), [{
      id: 'compact',
      name: '压缩',
      description: '压缩当前会话上下文，释放上下文空间',
      keywords: ['compact', 'context'],
      disabled: true,
    }])
  })

  it('空闲时按续接状态提供 BTW 与 BBTW', () => {
    assert.deepEqual(createComposerCommands({
      compactAvailable: true,
      compactDisabled: false,
      forkAvailable: true,
      forkDisabled: false,
      btwAvailable: true,
      bbtwAvailable: true,
    }).map((command) => command.id), ['mcp', 'btw', 'bbtw', 'fork', 'compact'])

    assert.deepEqual(createComposerCommands({
      compactAvailable: true,
      compactDisabled: true,
      forkAvailable: false,
      forkDisabled: false,
      btwAvailable: false,
      bbtwAvailable: false,
    }).map((command) => command.id), ['mcp', 'compact'])
  })
})

describe('输入框 Skill 目录刷新', () => {
  it('SSH 连接后在当前会话开始读取，并用新目录替换未连接结果', async t => {
    const page = await composerFixture(t)
    await act(async () => page.requests[0]!.resolve(disconnectedCatalog))
    assert.equal(page.current.loading, false)
    assert.equal(page.current.catalog.diagnostics[0]?.message, '连接 SSH 后可使用远端 Skill')

    await act(async () => { for (const listener of page.listeners) listener() })
    assert.equal(page.current.loading, true)
    assert.equal(page.requests[1]?.runtimeId, 'ssh-session')
    await act(async () => page.requests[1]!.resolve(connectedCatalog))
    assert.equal(page.current.loading, false)
    assert.equal(page.current.catalog.diagnostics.length, 0)
    assert.deepEqual(page.current.catalog.skills, connectedCatalog.skills)
  })

  it('每次重新打开斜杠菜单读取目录，输入筛选文字不重复扫描，刷新保留已读 Skill', async t => {
    const page = await composerFixture(t)
    await act(async () => page.requests[0]!.resolve(connectedCatalog))
    await act(async () => page.current.updateMenu('/', 1))
    assert.equal(page.requests.length, 2)
    assert.equal(page.current.loading, true)
    assert.equal(page.current.matches.filter(item => item.kind === 'skill').length, 1)
    await act(async () => page.current.updateMenu('/review', 7))
    assert.equal(page.requests.length, 2)
    await act(async () => page.requests[1]!.resolve(connectedCatalog))
    await act(async () => page.current.updateMenu('', 0))
    await act(async () => page.current.updateMenu('/', 1))
    assert.equal(page.requests.length, 3)
    assert.equal(page.current.loading, true)
    await act(async () => page.requests[2]!.resolve({ ...connectedCatalog, skills: [] }))
    assert.equal(page.current.loading, false)
    assert.equal(page.current.matches.filter(item => item.kind === 'skill').length, 0)
  })

  it('连接变化和菜单读取交错时，旧结果和旧失败不能结束最新读取或覆盖目录', async t => {
    const page = await composerFixture(t)
    await act(async () => page.current.updateMenu('/', 1))
    await act(async () => page.requests[0]!.resolve(disconnectedCatalog))
    assert.equal(page.current.loading, true)
    assert.equal(page.current.catalog.diagnostics.length, 0)
    await act(async () => { for (const listener of page.listeners) listener() })
    await act(async () => page.requests[2]!.resolve(connectedCatalog))
    await act(async () => page.requests[1]!.reject(new Error('旧连接已断开')))
    assert.equal(page.current.loading, false)
    assert.deepEqual(page.current.catalog.skills, connectedCatalog.skills)
    assert.equal(page.current.catalog.diagnostics.length, 0)
  })

  it('读取失败结束加载；切换会话后忽略旧请求并清除旧读取状态', async t => {
    const page = await composerFixture(t)
    await act(async () => page.requests[0]!.reject(new Error('SSH 文件请求超时')))
    assert.equal(page.current.loading, false)
    assert.match(page.current.catalog.diagnostics[0]!.message, /SSH 文件请求超时/)
    await act(async () => page.current.updateMenu('/', 1))
    await page.switchRuntime('other-session')
    assert.equal(page.current.loading, true)
    assert.equal(page.current.catalog.diagnostics.length, 0)
    await act(async () => page.requests[2]!.resolve({ ...connectedCatalog, skills: [] }))
    await act(async () => page.requests[1]!.resolve(connectedCatalog))
    assert.equal(page.current.loading, false)
    assert.equal(page.current.catalog.skills.length, 0)
  })
})

const disconnectedCatalog: SkillCatalogSnapshot = {
  revision: 'disconnected', skills: [], modelContext: null, omittedCount: 0,
  diagnostics: [{ path: '', message: '连接 SSH 后可使用远端 Skill' }],
}
const connectedCatalog: SkillCatalogSnapshot = {
  revision: 'connected', diagnostics: [], modelContext: null, omittedCount: 0,
  skills: [{
    id: `skill:${'a'.repeat(64)}`, name: 'review', description: '检查项目', scope: 'user',
    path: '/home/test/.agents/skills/review/SKILL.md', rootPath: '/home/test/.agents/skills/review',
  }],
}

async function composerFixture(t: TestContext) {
  const { window, document } = parseHTML('<html><body></body></html>')
  const requests: Array<{
    runtimeId: string
    resolve: (catalog: SkillCatalogSnapshot) => void
    reject: (error: Error) => void
  }> = []
  const listeners = new Set<() => void>()
  Object.defineProperty(window, 'whycode', { value: {
    listSkills: (runtimeId: string) => new Promise<SkillCatalogSnapshot>((resolve, reject) => {
      requests.push({ runtimeId, resolve, reject })
    }),
    onSshChanged: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }, configurable: true })
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
    assert.equal(listeners.size, 0)
  })
  const options: Parameters<typeof useSkillComposer>[0] = {
    input: '', setInput: () => {}, inputRef: { current: '' },
    runtimeId: 'ssh-session', runtimeIdRef: { current: 'ssh-session' },
    modelId: '', projectDir: '/home/test', workspaceMode: 'ssh', skillsEnabled: true,
    compactAvailable: false, compactDisabled: false, forkAvailable: false, forkDisabled: false,
    btwAvailable: false, bbtwAvailable: false, onCommand: () => {},
  }
  let current!: ReturnType<typeof useSkillComposer>
  function Composer() { current = useSkillComposer(options); return null }
  await act(async () => root.render(createElement(Composer)))
  return {
    get current() { return current }, requests, listeners,
    switchRuntime: (runtimeId: string) => act(async () => {
      options.runtimeId = runtimeId; options.runtimeIdRef.current = runtimeId
      current.resetCatalog(); current.closeMenu()
      root.render(createElement(Composer))
    }),
  }
}
