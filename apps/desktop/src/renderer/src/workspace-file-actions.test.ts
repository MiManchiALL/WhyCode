import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { performWorkspaceFileAction } from './workspace-file-actions.ts'
import type { WorkspaceFileResult } from '../../shared/workspace-files.ts'

function fixture() {
  const calls: unknown[] = []
  const view = { kind: 'file' as const, id: 'lease', path: 'C:/report.docx', name: 'report.docx', format: 'unsupported' as const, mediaType: 'application/octet-stream', size: 10, url: null }
  return {
    calls,
    api: {
      openWorkspaceFile: async (request: unknown): Promise<WorkspaceFileResult> => { calls.push(request); return { ok: true, view } },
      closeWorkspaceFile: (id: string) => { calls.push(['close', id]) },
      openWorkspaceFileExternally: async (id: string) => { calls.push(['open', id]) },
      revealWorkspaceFile: async (id: string) => { calls.push(['reveal', id]) },
    },
  }
}

describe('交付文件的用户操作', () => {
  it('按会话取得文件视图，通过视图执行打开或定位并立即释放', async () => {
    for (const action of ['open', 'reveal'] as const) {
      const { api, calls } = fixture()
      await performWorkspaceFileAction(api, 'runtime-a', 'C:/report.docx', action, new AbortController().signal)
      assert.deepEqual(calls, [{ runtimeId: 'runtime-a', kind: 'file', path: 'C:/report.docx' }, [action, 'lease'], ['close', 'lease']])
    }
  })

  it('文件不存在时不调用系统应用；默认应用失败也释放资源并传回错误', async () => {
    const { api, calls } = fixture()
    api.openWorkspaceFileExternally = async () => { throw new Error('没有关联应用') }
    await assert.rejects(performWorkspaceFileAction(api, 'r', 'C:/report.docx', 'open', new AbortController().signal), /关联应用/)
    assert.deepEqual(calls.at(-1), ['close', 'lease'])
    calls.length = 0
    api.openWorkspaceFile = async () => ({ ok: false, error: '文件已删除' })
    await assert.rejects(performWorkspaceFileAction(api, 'r', 'C:/report.docx', 'open', new AbortController().signal), /已删除/)
    assert.deepEqual(calls, [])
  })

  it('切换会话时取消未完成的读取，不再打开系统应用，并回收迟到的视图', async () => {
    const { api, calls } = fixture()
    const abort = new AbortController()
    const open = api.openWorkspaceFile
    api.openWorkspaceFile = async request => { abort.abort(); return open(request) }
    await assert.rejects(performWorkspaceFileAction(api, 'r', 'C:/report.docx', 'open', abort.signal), /abort/i)
    assert.deepEqual(calls, [{ runtimeId: 'r', kind: 'file', path: 'C:/report.docx' }, ['close', 'lease']])
  })
})
