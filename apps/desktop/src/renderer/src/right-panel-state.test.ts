import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  activeRightPanelPage,
  defaultGitPage,
  browserReferencePage,
  closeRightPanelTab,
  closeBrowserTabs,
  canAddRightPanelTab,
  MAX_RIGHT_PANEL_TABS,
  openRightPanelPage,
  moveRightPanelTab,
  RightPanelSessionStore,
  rightPanelSessionKey,
  rightPanelTabId,
  selectRightPanelTab,
  updateRightPanelPage,
  type RightPanelPage,
  type RightPanelSessionState,
} from './right-panel-state.ts'

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

const emptyState = (): RightPanelSessionState => ({
  open: false,
  tabs: [],
  activeTabId: null,
  inspectorView: 'plan',
})

function snapshotPage(
  path: string,
  toolUseId: string,
  toolName: 'WriteFile' | 'EditFile' | 'DeleteFile' = 'EditFile',
): Extract<RightPanelPage, { kind: 'file' }> {
  return {
    kind: 'file',
    path,
    name: path.replaceAll('\\', '/').split('/').at(-1) ?? path,
    source: { kind: 'snapshot', toolUseId, toolName },
  }
}

describe('右侧栏会话配置', () => {
  it('Git 比较和文件选择随会话保存，独立于本轮改动且不持久化正文', () => {
    const storage = new MemoryStorage()
    const store = new RightPanelSessionStore(storage)
    const git: RightPanelPage = { ...defaultGitPage(), baseRef: 'refs/remotes/origin/main', mode: 'commit',
      commit: 'a'.repeat(40), selectedPath: 'src/中文.ts', expandedPaths: ['src/中文.ts'] }
    let state = openRightPanelPage(emptyState(), git)
    state = openRightPanelPage(state, { kind: 'changes', checkpointIds: ['checkpoint'], expandedPaths: [], selectedPath: null })
    store.set('session-a', state)
    store.set('session-b', openRightPanelPage(emptyState(), defaultGitPage()))
    const restored = new RightPanelSessionStore(storage)
    assert.deepEqual(restored.get('session-a').tabs.find(tab => tab.id === 'git')?.page, git)
    assert.equal(restored.get('session-a').tabs.length, 2)
    assert.equal(restored.get('session-b').tabs.length, 1)
    assert.deepEqual(restored.get('session-b').tabs[0]?.page, defaultGitPage())
    restored.delete('session-a')
    assert.equal(new RightPanelSessionStore(storage).get('session-a').tabs.length, 0)
  })
  it('同一路径再次引用复用已打开的浏览器及其位置，满标签时也不新建', () => {
    const file = { kind: 'browser' as const, id: 'svg', url: 'file:///C:/Project/sample%20one.svg#detail', title: 'Sample' }
    let state = openRightPanelPage(emptyState(), file)
    for (let i = 1; i < MAX_RIGHT_PANEL_TABS; i++) state = openRightPanelPage(state, { kind: 'browser', id: String(i), url: 'about:blank', title: '' })
    const selected = browserReferencePage(state, 'file:///c:/project/SAMPLE%20ONE.svg', true, { kind: 'new' })
    assert.deepEqual(selected, { ...file, referenceRequest: { kind: 'new' } })
    state = openRightPanelPage(state, selected)
    assert.equal(state.activeTabId, 'browser:svg')
    assert.equal(state.tabs.length, MAX_RIGHT_PANEL_TABS)
  })
  it('SSH 会话引用文件时不会复用同名本机网页，远端路径仍区分大小写', () => {
    const local = { kind: 'browser' as const, id: 'local', url: 'file:///home/project/index.html', title: '' }
    const remote = { ...local, id: 'remote', workspaceFile: true }
    const state = openRightPanelPage(openRightPanelPage(emptyState(), local), remote)
    const request = { kind: 'new' as const }
    assert.equal(browserReferencePage(state, local.url, false, request, undefined, true).id, 'local')
    assert.equal(browserReferencePage(state, local.url, true, request, undefined, true).id, 'remote')
    assert.notEqual(browserReferencePage(state, 'file:///home/Project/index.html', true, request, undefined, true).id, 'remote')
  })
  it('重新编辑优先原浏览器，页面关闭后按网址重开，临时页面不从省略正文重建', () => {
    const first = { kind: 'browser' as const, id: 'first', url: 'https://example.test/', title: '' }
    const second = { ...first, id: 'second' }
    let state = openRightPanelPage(openRightPanelPage(emptyState(), first), second)
    const request = { kind: 'edit' as const, draftId: 'draft' }
    assert.equal(browserReferencePage(state, first.url, false, request, second.id).id, second.id)
    state = closeRightPanelTab(closeRightPanelTab(state, 'browser:first'), 'browser:second')
    const reopened = browserReferencePage(state, first.url, false, request, second.id)
    assert.equal(reopened.url, first.url)
    assert.deepEqual(reopened.referenceRequest, request)
    assert.notEqual(reopened.id, second.id)
    assert.throws(() => browserReferencePage(state, 'data:text/html,[页面内容省略]', false, request, 'data'), /临时页面已关闭/u)
    state = openRightPanelPage(state, { ...first, id: 'data', url: 'data:text/html,<p>test</p>' })
    assert.equal(browserReferencePage(state, 'data:text/html,[页面内容省略]', false, request, 'data').url, 'data:text/html,<p>test</p>')
  })
  it('工作区网页保留远端文件作用域，重启不重新开启一次性的引用模式', () => {
    const storage = new MemoryStorage()
    const page = { kind: 'browser' as const, id: 'remote', url: 'file:///home/project/index.html', title: 'Remote',
      workspaceFile: true, referenceRequest: { kind: 'new' as const } }
    const store = new RightPanelSessionStore(storage)
    store.set('conversation', openRightPanelPage(emptyState(), page))
    assert.deepEqual((store.get('conversation').tabs[0]?.page as typeof page).referenceRequest, { kind: 'new' })
    const restored = new RightPanelSessionStore(storage).get('conversation').tabs[0]!.page
    assert.ok(restored.kind === 'browser')
    assert.equal(restored.workspaceFile, true)
    assert.equal(restored.referenceRequest, undefined)
  })
  it('全部清理关闭当前与后台会话的浏览器标签，保留其它面板与阅读位置', () => {
    const storage = new MemoryStorage()
    const store = new RightPanelSessionStore(storage)
    const file = snapshotPage('E:/index.html', 'tool')
    let state = openRightPanelPage(emptyState(), file)
    for (const id of ['a', 'b']) state = openRightPanelPage(state, { kind: 'browser', id, url: `https://${id}.test/`, title: id })
    state = selectRightPanelTab(state, rightPanelTabId(file))
    store.set('current', state)
    store.set('background', selectRightPanelTab(state, 'browser:b'))
    store.set('only-browser', openRightPanelPage(emptyState(), { kind: 'browser', id: 'c', url: 'data:text/html,private', title: '' }))
    const closed = closeBrowserTabs(state)
    assert.deepEqual(closed.tabs, [{ id: rightPanelTabId(file), page: file }])
    assert.equal(closed.activeTabId, state.activeTabId)
    assert.equal(updateRightPanelPage(closed, state.tabs[1]!.page), closed)
    store.removeBrowserTabs()
    const restored = new RightPanelSessionStore(storage)
    for (const key of ['current', 'background']) assert.deepEqual(restored.get(key), closed)
    assert.deepEqual(restored.get('only-browser').tabs, [])
    assert.equal(restored.get('only-browser').activeTabId, null)
    assert.equal([...storage.values.values()].some(value => value.includes('https://')), false)
  })
  it('浏览器标签独立保存网址，后台标题变化不抢焦点，已关闭标签不会被迟到更新恢复', () => {
    const first = { kind: 'browser' as const, id: 'a', url: 'https://example.com/', title: 'Example' }
    const second = { kind: 'browser' as const, id: 'b', url: 'http://localhost:3000/', title: 'Game' }
    let state = openRightPanelPage(openRightPanelPage(emptyState(), first), second)
    state = updateRightPanelPage(state, { ...first, title: 'Updated' })
    assert.equal(state.activeTabId, 'browser:b')
    const storage = new MemoryStorage()
    new RightPanelSessionStore(storage).set('conversation', state)
    assert.deepEqual(new RightPanelSessionStore(storage).get('conversation'), state)
    state = closeRightPanelTab(state, 'browser:a')
    assert.equal(updateRightPanelPage(state, first), state)
  })
  it('网址和标题投影保留待处理引用，消费后不会被迟到投影重新写回', () => {
    const page = { kind: 'browser' as const, id: 'reference', url: 'https://example.com/', title: '' }
    const request = { kind: 'new' as const }
    let state = openRightPanelPage(emptyState(), { ...page, referenceRequest: request, workspaceFile: true })
    state = updateRightPanelPage(state, { ...page, title: 'Ready', workspaceFile: undefined })
    assert.deepEqual(state.tabs[0]!.page, { ...page, title: 'Ready', referenceRequest: request, workspaceFile: undefined })
    state = updateRightPanelPage(state, { ...page, referenceRequest: undefined })
    state = updateRightPanelPage(state, { ...page, title: 'Later title' })
    assert.deepEqual(state.tabs[0]!.page, { ...page, title: 'Later title', referenceRequest: undefined, workspaceFile: undefined })
  })
  it('标签上限不会自动淘汰仍有网页状态的浏览器，关闭后可继续新建', () => {
    let state = emptyState()
    for (let i = 0; i < MAX_RIGHT_PANEL_TABS; i++) state = openRightPanelPage(state, { kind: 'browser', id: String(i), url: 'about:blank', title: '' })
    assert.equal(canAddRightPanelTab(state), false)
    const file = { kind: 'file' as const, path: '/note.txt', name: 'note.txt', source: { kind: 'current' as const } }
    assert.equal(openRightPanelPage(state, file), state)
    state = closeRightPanelTab(state, 'browser:0')
    assert.equal(canAddRightPanelTab(state), true)
    assert.equal(openRightPanelPage(state, file).tabs.length, MAX_RIGHT_PANEL_TABS)
  })
  it('data 临时页保留进程内切换状态，磁盘只恢复普通网址与本机文件', () => {
    const storage = new MemoryStorage()
    const store = new RightPanelSessionStore(storage)
    const local = { kind: 'browser' as const, id: 'file', url: 'file:///C:/demo/index.html', title: 'Local' }
    const inline = { kind: 'browser' as const, id: 'data', url: 'data:text/html,<h1>Temporary</h1>', title: 'Inline' }
    const state = openRightPanelPage(openRightPanelPage(emptyState(), local), inline)
    store.set('conversation', state)
    assert.deepEqual(store.get('conversation'), state)
    assert.equal([...storage.values.values()].some(value => value.includes('Temporary')), false)
    const restored = new RightPanelSessionStore(storage).get('conversation')
    assert.deepEqual(restored.tabs.map(tab => tab.page), [local])
    assert.equal(restored.activeTabId, 'browser:file')
  })
  it('改动卡片与逐文件入口复用一个标签，打开当前文件后能保留并返回原差异列表', () => {
    const overview: Extract<RightPanelPage, { kind: 'changes' }> = {
      kind: 'changes', checkpointIds: ['checkpoint-a', 'checkpoint-b'],
      expandedPaths: [], selectedPath: null,
    }
    let state = openRightPanelPage(emptyState(), overview)
    const changesId = state.activeTabId
    const selected = { ...overview, expandedPaths: ['C:/repo/app.ts'], selectedPath: 'C:/repo/app.ts' }
    state = openRightPanelPage(state, selected)
    assert.equal(state.tabs.length, 1)
    assert.equal(state.activeTabId, changesId)
    for (const path of ['C:/repo/app.ts', 'c:\\REPO\\APP.ts']) {
      state = openRightPanelPage(state, { kind: 'file', path, name: 'app.ts', source: { kind: 'current' }, previewMode: 'code' })
    }
    assert.equal(state.tabs.length, 2)
    state = selectRightPanelTab(state, changesId!)
    assert.deepEqual(activeRightPanelPage(state), selected)
    const storage = new MemoryStorage()
    new RightPanelSessionStore(storage).set('session-a', state)
    assert.deepEqual(new RightPanelSessionStore(storage).get('session-a'), state)
    state = openRightPanelPage(state, overview)
    assert.deepEqual(activeRightPanelPage(state), overview)
    state = openRightPanelPage(state, { ...overview, checkpointIds: ['next-turn'] })
    assert.equal(state.tabs.length, 2)
    assert.equal(state.activeTabId, changesId)
  })

  it('排序只改变目标会话的顺序，保持活动内容与页面设置，关闭时按新顺序选择邻居', () => {
    let state = emptyState()
    for (const name of ['a.md', 'b.html', 'c.ts']) {
      state = openRightPanelPage(state, { kind: 'file', path: `E:/${name}`, name, source: { kind: 'current' }, wrap: true, previewMode: 'code' })
    }
    const [first, second, third] = state.tabs
    const reordered = moveRightPanelTab(state, third!.id, first!.id)
    assert.deepEqual(reordered.tabs, [third, first, second])
    assert.equal(activeRightPanelPage(reordered), activeRightPanelPage(state))
    assert.equal(moveRightPanelTab(reordered, 'missing', first!.id), reordered)
    assert.equal(moveRightPanelTab(reordered, first!.id, first!.id), reordered)
    const storage = new MemoryStorage()
    const store = new RightPanelSessionStore(storage)
    store.set('session-a', reordered)
    store.set('session-b', state)
    const restored = new RightPanelSessionStore(storage)
    assert.deepEqual(restored.get('session-a'), reordered)
    assert.deepEqual(restored.get('session-b'), state)
    assert.equal(closeRightPanelTab(reordered, third!.id).activeTabId, first!.id)
  })
  it('独立保存每个会话的任务面板选择，空侧栏也保留；删除会话时清理', () => {
    const storage = new MemoryStorage()
    const store = new RightPanelSessionStore(storage)
    store.set('runtime:draft', { ...emptyState(), inspectorView: 'skills' })
    store.move('runtime:draft', 'session-a')
    store.set('session-b', emptyState())
    const restored = new RightPanelSessionStore(storage)
    assert.equal(restored.get('session-a').inspectorView, 'skills')
    assert.equal(restored.get('session-b').inspectorView, 'plan')
    const withTab = openRightPanelPage(restored.get('session-a'), { kind: 'subagent-overview' })
    assert.equal(closeRightPanelTab(withTab, withTab.activeTabId!).inspectorView, 'skills')
    restored.delete('session-a')
    assert.deepEqual(new RightPanelSessionStore(storage).get('session-a'), emptyState())
  })

  it('按会话保存通用多标签描述并在重建后恢复', () => {
    const storage = new MemoryStorage()
    const store = new RightPanelSessionStore(storage)
    let fileState = openRightPanelPage(emptyState(), snapshotPage(
      'C:\\repo\\src\\app.ts',
      'tool-1',
    ))
    fileState = openRightPanelPage(fileState, snapshotPage(
      'C:\\repo\\src\\other.ts',
      'tool-2',
      'DeleteFile',
    ))
    store.set('session-a', fileState)
    store.set('session-b', openRightPanelPage(emptyState(), {
      kind: 'subagent-transcript',
      subagentId: 'agent-1',
    }))

    const restored = new RightPanelSessionStore(storage)
    assert.equal(restored.get('session-a').tabs.length, 2)
    assert.deepEqual(activeRightPanelPage(restored.get('session-a')), snapshotPage(
      'C:\\repo\\src\\other.ts',
      'tool-2',
      'DeleteFile',
    ))
    assert.deepEqual(activeRightPanelPage(restored.get('session-b')), {
      kind: 'subagent-transcript',
      subagentId: 'agent-1',
    })
  })

  it('同一路径的历史版本与当前文件共享标签，不同路径并列', () => {
    let state = openRightPanelPage(emptyState(), snapshotPage(
      'C:\\Repo\\app.ts',
      'tool-1',
      'WriteFile',
    ))
    state = openRightPanelPage(state, snapshotPage('c:\\repo\\APP.ts', 'tool-2'))
    assert.equal(state.tabs.length, 1)
    assert.deepEqual(activeRightPanelPage(state), snapshotPage('c:\\repo\\APP.ts', 'tool-2'))

    state = openRightPanelPage(state, {
      kind: 'file',
      path: 'C:\\Repo\\app.ts',
      name: 'app.ts',
      source: { kind: 'current' },
    })
    assert.equal(state.tabs.length, 1)
    assert.equal((activeRightPanelPage(state) as { source: { kind: string } }).source.kind, 'current')

    state = openRightPanelPage(state, snapshotPage('C:\\Repo\\other.ts', 'tool-3'))
    assert.equal(state.tabs.length, 2)
  })

  it('子代理总览和详情共用一个可扩展页面标签', () => {
    let state = openRightPanelPage(emptyState(), { kind: 'subagent-overview' })
    state = openRightPanelPage(state, {
      kind: 'subagent-transcript',
      subagentId: 'agent-1',
    })
    assert.equal(state.tabs.length, 1)
    assert.deepEqual(activeRightPanelPage(state), {
      kind: 'subagent-transcript',
      subagentId: 'agent-1',
    })
  })

  it('切换与关闭标签不会丢失其它页面', () => {
    let state = openRightPanelPage(emptyState(), snapshotPage('C:\\repo\\a.ts', 'tool-a'))
    state = openRightPanelPage(state, snapshotPage('C:\\repo\\b.ts', 'tool-b'))
    const firstId = rightPanelTabId(snapshotPage('C:\\repo\\a.ts', 'ignored'))
    state = selectRightPanelTab(state, firstId)
    assert.equal((activeRightPanelPage(state) as { name: string }).name, 'a.ts')
    state = closeRightPanelTab(state, firstId)
    assert.equal(state.tabs.length, 1)
    assert.equal((activeRightPanelPage(state) as { name: string }).name, 'b.ts')
  })

  it('标签达到上限时只淘汰一个非当前轻量描述符', () => {
    let state = emptyState()
    for (let index = 0; index < MAX_RIGHT_PANEL_TABS; index++) {
      state = openRightPanelPage(state, snapshotPage(`C:\\repo\\${index}.ts`, `tool-${index}`))
    }
    const activeBefore = state.activeTabId
    state = openRightPanelPage(state, snapshotPage('C:\\repo\\next.ts', 'tool-next'))
    assert.equal(state.tabs.length, MAX_RIGHT_PANEL_TABS)
    assert.ok(state.tabs.some((tab) => tab.id === activeBefore))
    assert.equal((activeRightPanelPage(state) as { name: string }).name, 'next.ts')
  })

  it('草稿运行时物化为会话时转移配置且删除后回到默认值', () => {
    const storage = new MemoryStorage()
    const store = new RightPanelSessionStore(storage)
    const state = openRightPanelPage(emptyState(), { kind: 'subagent-overview' })
    store.set('runtime:draft', state)

    assert.deepEqual(store.move('runtime:draft', 'session-a'), state)
    assert.deepEqual(store.get('runtime:draft'), emptyState())
    store.delete('session-a')
    assert.deepEqual(store.get('session-a'), emptyState())
  })

  it('侧栏收起后仍保留标签，下一次展开与重启不会丢失页面类型', () => {
    const storage = new MemoryStorage()
    const opened = openRightPanelPage(emptyState(), { kind: 'subagent-overview' })
    const state = { ...opened, open: false }
    new RightPanelSessionStore(storage).set('session-a', state)
    assert.deepEqual(new RightPanelSessionStore(storage).get('session-a'), state)
  })

  it('会话键在会话落盘前使用运行时身份', () => {
    assert.equal(rightPanelSessionKey('runtime-a', null), 'runtime:runtime-a')
    assert.equal(rightPanelSessionKey('runtime-a', 'session-a'), 'session-a')
  })

  it('终端并列保留但不持久化；描述符淘汰与会话切换不能关闭终端', () => {
    const storage = new MemoryStorage()
    const store = new RightPanelSessionStore(storage)
    let state = emptyState()
    for (const id of ['a', 'b']) state = openRightPanelPage(state, {
      kind: 'terminal', terminal: { id, title: `终端 ${id}`, cwd: 'E:\\project' },
    })
    for (let index = 0; index < MAX_RIGHT_PANEL_TABS; index++) {
      state = openRightPanelPage(state, snapshotPage(`E:\\${index}.ts`, `tool-${index}`))
    }
    assert.equal(state.tabs.length, MAX_RIGHT_PANEL_TABS)
    assert.deepEqual(state.tabs.filter((tab) => tab.page.kind === 'terminal').map((tab) => tab.id), ['terminal:a', 'terminal:b'])
    state = selectRightPanelTab(state, 'terminal:b')
    store.set('session-a', state)
    assert.deepEqual(store.get('session-a'), state)
    const disk = new RightPanelSessionStore(storage).get('session-a')
    assert.equal(disk.tabs.some((tab) => tab.page.kind === 'terminal'), false)
    assert.equal(activeRightPanelPage(disk)?.kind, 'file')
    assert.equal([...storage.values.values()].some((value) => value.includes('terminal')), false)
    for (let index = 0; index < 205; index++) {
      store.set(`other-${index}`, openRightPanelPage(emptyState(), { kind: 'subagent-overview' }))
    }
    assert.equal(store.get('session-a').tabs.filter((tab) => tab.page.kind === 'terminal').length, 2)
    store.removeTerminal('b')
    assert.equal(store.get('session-a').tabs.some((tab) => tab.id === 'terminal:b'), false)
    assert.equal(store.get('session-a').tabs.some((tab) => tab.id === 'terminal:a'), true)
  })
})

it('目录展开与文件显示偏好按会话保存，打开同一文件保留偏好', () => {
  const storage = new MemoryStorage()
  const store = new RightPanelSessionStore(storage)
  let state = openRightPanelPage(emptyState(), { kind: 'workspace', expanded: ['src', 'src/main'] })
  const page = { kind: 'file', path: 'C:/repo/index.html', name: 'index.html', source: { kind: 'current' } } as const
  state = openRightPanelPage(state, { ...page, wrap: false, previewMode: 'code' })
  state = openRightPanelPage(state, page)
  assert.deepEqual(activeRightPanelPage(state), { ...page, wrap: false, previewMode: 'code' })
  store.set('a', state)
  const restored = new RightPanelSessionStore(storage)
  assert.deepEqual(restored.get('a'), state)
  assert.deepEqual(restored.get('b'), emptyState())
  assert.deepEqual(restored.get('a').tabs[0]?.page, { kind: 'workspace', expanded: ['src', 'src/main'] })
})

it('工具与交付入口显式选择代码和预览，仍复用同一文件标签及换行偏好', () => {
  const page = { kind: 'file', path: 'C:/repo/index.html', name: 'index.html', source: { kind: 'current' } } as const
  let state = openRightPanelPage(emptyState(), { ...page, wrap: true, previewMode: 'preview' })
  state = openRightPanelPage(state, { ...page, previewMode: 'code', source: { kind: 'snapshot', toolUseId: 't', toolName: 'WriteFile' } })
  assert.equal(state.tabs.length, 1)
  const current = activeRightPanelPage(state)
  assert.ok(current?.kind === 'file')
  assert.equal(current.previewMode, 'code')
  state = openRightPanelPage(state, { ...page, previewMode: 'preview' })
  assert.deepEqual(activeRightPanelPage(state), { ...page, previewMode: 'preview', wrap: true })
})
