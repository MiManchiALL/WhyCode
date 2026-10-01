import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import type { OpenWorkspaceFileRequest, WorkspaceFileChange, WorkspaceFileResult } from '../../shared/workspace-files.ts'
import { WorkspaceDirectories } from './workspace-directories.ts'
import { WorkspaceFileResource } from './workspace-file-resource.ts'

describe('目录标签的数据所有权', () => {
  it('切换标签保留列表和监听，本地无变化不重读，隐藏期间多次变化在切回时合并读取', async () => {
    const api = fixture()
    const tree = new WorkspaceDirectories(api, 'a', '0')
    tree.setActive(true, false)
    const root = tree.get('')
    await root.refresh()
    const snapshot = root.getSnapshot().view
    tree.setActive(false, false)
    tree.setActive(true, false)
    assert.equal(tree.get('').getSnapshot().view, snapshot)
    assert.equal(api.calls.length, 1)
    tree.setActive(false, false)
    api.entries = ['new.txt']
    api.change(); api.change()
    assert.equal(api.calls.length, 1)
    tree.setActive(true, false)
    await root.refresh()
    assert.equal(api.calls.length, 2)
    assert.deepEqual(names(root), ['new.txt'])
    tree.close()
    assert.equal(api.views.size, 0)
    assert.equal(api.listeners.size, 0)
  })

  it('SSH 返回立即提供原列表，后台发现外部变化；失败保留列表并允许重试', async () => {
    const api = fixture()
    const tree = new WorkspaceDirectories(api, 'a', '0')
    tree.setActive(true, true)
    const root = tree.get('')
    await root.refresh()
    tree.setActive(false, true)
    const release = api.hold()
    tree.setActive(true, true)
    assert.deepEqual(names(root), ['old.txt'])
    assert.equal(root.getSnapshot().loading, true)
    api.entries = ['external.txt']
    release()
    await root.refresh()
    assert.deepEqual(names(root), ['external.txt'])
    api.failure = '服务器不可达'
    assert.equal(await root.refresh(), false)
    assert.deepEqual(names(root), ['external.txt'])
    assert.equal(root.getSnapshot().error, '服务器不可达')
    api.failure = null
    await root.refresh()
    assert.equal(root.getSnapshot().error, null)
    tree.close()
  })

  it('刷新已加载的分页只在读取完整后提交，不缩短列表；读取期间的变化接着核对', async () => {
    const api = fixture()
    api.entries = Array.from({ length: 450 }, (_, i) => `file-${i}.txt`)
    const file = new WorkspaceFileResource(api, { runtimeId: 'a', kind: 'directory', path: '' })
    await file.refresh(); await file.refresh(200)
    assert.equal(names(file).length, 400)
    const release = api.hold()
    const refresh = file.refresh()
    api.entries[1] = 'updated.txt'
    api.change(); api.change()
    assert.equal(names(file).length, 400)
    release()
    await refresh
    await file.refresh()
    assert.equal(names(file).length, 400)
    assert.equal(names(file)[1], 'updated.txt')
    assert.deepEqual(api.calls.map(call => call.offset), [0, 200, 0, 200, 0, 200])
    file.close()
  })

  it('收起目录、关闭标签与迟到的首次响应都释放资源；重新打开不接收旧结果', async () => {
    const api = fixture()
    const tree = new WorkspaceDirectories(api, 'a', '0')
    const root = tree.get('')
    await root.refresh()
    const child = tree.get('A')
    await child.refresh()
    tree.retain([])
    assert.equal(api.views.size, 1)
    assert.equal(child.getSnapshot().view, null)
    const release = api.hold()
    const opening = tree.get('B').refresh()
    tree.close()
    assert.equal(root.getSnapshot().view, null)
    release()
    await opening
    assert.equal(api.views.size, 0)
    assert.equal(api.listeners.size, 0)
    // React 开发期重放 Effect 时，同一个所有者可以重新建立有效资源。
    assert.equal(tree.get(''), root)
    await root.refresh()
    assert.equal(api.views.size, 1)
    tree.close()
  })

  it('首批完成后可立即继续恢复下一页，已删除目录的整个子树释放监听', async () => {
    const api = fixture()
    api.entries = ['A/', ...Array.from({ length: 399 }, (_, i) => `file-${i}.txt`)]
    const tree = new WorkspaceDirectories(api, 'a', '0')
    const root = tree.get('')
    const unsubscribe = root.subscribe(() => {
      const state = root.getSnapshot()
      if (!state.loading && state.view?.kind === 'directory' && state.view.entries.length === 200) void root.refresh(200)
    })
    await root.refresh()
    await root.refresh(200)
    unsubscribe()
    assert.equal(names(root).length, 400)
    assert.deepEqual(api.calls.map(call => call.offset), [0, 200])
    const child = tree.get('A')
    await child.refresh()
    const nested = tree.get('A/deep')
    await nested.refresh()
    api.entries = ['replacement.txt']
    await root.refresh()
    assert.equal(api.views.size, 1)
    assert.equal(child.getSnapshot().view, null)
    assert.equal(nested.getSnapshot().view, null)
    tree.close()
  })

  it('文件预览收到变化只标记过期，不自动替换正文，手动刷新清除标记', async () => {
    const api = fixture()
    const file = new WorkspaceFileResource(api, { runtimeId: 'a', kind: 'file', path: '/note.txt' })
    await file.refresh()
    api.change()
    await setImmediate()
    assert.equal(api.calls.length, 1)
    assert.equal(file.getSnapshot().changed, true)
    await file.refresh()
    assert.equal(file.getSnapshot().changed, false)
    file.close()
  })
})

function names(file: WorkspaceFileResource): string[] {
  const view = file.getSnapshot().view
  assert.equal(view?.kind, 'directory')
  return view?.kind === 'directory' ? view.entries.map(entry => entry.name) : []
}

function fixture() {
  const views = new Map<string, OpenWorkspaceFileRequest>()
  const listeners = new Set<(event: WorkspaceFileChange) => void>()
  const calls: { id: string; offset: number }[] = []
  let nextId = 0
  let gate: Promise<void> | null = null
  const api = {
    views, listeners, calls, entries: ['old.txt'], failure: null as string | null,
    hold() {
      let release!: () => void
      gate = new Promise<void>(resolve => { release = resolve })
      return () => { gate = null; release() }
    },
    change() { for (const id of views.keys()) for (const listener of listeners) listener({ id }) },
    onWorkspaceFileChanged(listener: (event: WorkspaceFileChange) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async openWorkspaceFile(request: OpenWorkspaceFileRequest): Promise<WorkspaceFileResult> {
      const id = `view-${++nextId}`
      views.set(id, request)
      return api.readWorkspaceFile({ id })
    },
    async readWorkspaceFile({ id, offset = 0 }: { id: string; offset?: number }): Promise<WorkspaceFileResult> {
      calls.push({ id, offset })
      await gate
      if (api.failure) return { ok: false, error: api.failure }
      const request = views.get(id)!
      if (request.kind === 'file') return { ok: true, view: { kind: 'file', id, path: request.path,
        name: 'note.txt', format: 'code', size: 3, mediaType: 'text/plain', url: '/note.txt' } }
      return { ok: true, view: { kind: 'directory', id, path: request.path, total: api.entries.length, missing: false,
        entries: api.entries.slice(offset, offset + 200).map(entry => {
          const name = entry.replace(/\/$/u, '')
          return { name, path: request.path ? `${request.path}/${name}` : name, kind: entry.endsWith('/') ? 'directory' : 'file' }
        }) } }
    },
    closeWorkspaceFile(id: string) { views.delete(id) },
  }
  return api
}
