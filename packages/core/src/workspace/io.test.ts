import assert from 'node:assert/strict'
import { posix } from 'node:path'
import { it } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { localWorkspaceIO, outsideWorkspaceBoundary, workspacePathKey, type WorkspaceIO } from './io.ts'
import { unknownWorkspaceOutcome } from './errors.ts'
import { editFileTool, writeFileTool } from '../tools/write-edit/index.ts'
import { StepToolApprovalBatcher } from '../agent/tool-approval.ts'
import type { ApprovalRequest } from '../agent/tool-approval.ts'

const virtualIO = (realpath: WorkspaceIO['fs']['realpath']): WorkspaceIO => ({
  ...localWorkspaceIO, identity: 'ssh:fixture', platform: 'linux', path: posix,
  fs: { ...localWorkspaceIO.fs, realpath },
})

it('POSIX 路径保留大小写，并检查新文件的符号链接父目录', async () => {
  const io = virtualIO(async value => {
    if (value === '/project/link/new.txt') throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return value === '/project/link' ? '/external' : value
  })
  assert.notEqual(workspacePathKey(io, '/project/A'), workspacePathKey(io, '/project/a'))
  assert.equal(await outsideWorkspaceBoundary(io, 'link/new.txt', '/project', []), '/project/link/new.txt')
  assert.equal(await outsideWorkspaceBoundary(io, 'file.txt', '/project', []), null)
  assert.equal(await outsideWorkspaceBoundary(io, '../external/a', '/project', ['/external']), null)
})

it('异步路径检查耗时不同仍合并一次审批，路径检查断线会结束等待', async () => {
  const io = virtualIO(async value => { if (value.includes('slow')) await delay(40); return value })
  const approvals: ApprovalRequest[] = []
  const permissions = { workspaceIO: io, mode: 'default' as const, projectDir: '/project', additionalDirs: [], sessionAllowedTools: [] }
  const batcher = new StepToolApprovalBatcher({ permissions: () => permissions, setStatus: () => {}, applySuggestion: () => {},
    requestApproval: async request => { approvals.push(request); return { approved: true } },
  })
  const ctx = { workspaceIO: io, projectDir: '/project', additionalDirs: [], abortSignal: new AbortController().signal }
  const definition = { ...writeFileTool, renderDiff: undefined }
  const result = await Promise.all(['fast', 'slow'].map(path => batcher.authorize(definition, { path, content: 'x' }, ctx, path)))
  assert.ok(result.every(item => item.approved))
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0]?.items?.length, 2)
  io.fs.realpath = async () => { throw unknownWorkspaceOutcome('断线') }
  await assert.rejects(batcher.authorize(definition, { path: 'failure', content: 'x' }, ctx, 'failure'), /结果未知/)
})

it('写入后丢失响应时保留结果未知，不自动再次写入补偿', async () => {
  const io = virtualIO(async path => path)
  let content = 'before'
  let writes = 0
  io.fs.readFile = (async (_path: string, encoding?: 'utf8') => encoding ? content : Buffer.from(content)) as WorkspaceIO['fs']['readFile']
  io.fs.writeFile = async (_path, value) => { content = String(value); writes++; throw unknownWorkspaceOutcome('断线') }
  const result = await editFileTool.execute({ edits: [{ path: 'value', oldText: 'before', newText: 'after' }] }, {
    workspaceIO: io, projectDir: '/project', additionalDirs: [], abortSignal: new AbortController().signal,
  })
  assert.equal(result.isError, true)
  assert.match(result.data, /结果未知/)
  assert.equal(content, 'after')
  assert.equal(writes, 1)
})

it('远端路径检查期间取消，不再请求审批或返回批准', async () => {
  const controller = new AbortController()
  const io = virtualIO(async path => { await delay(10); controller.abort(); return path })
  const batcher = new StepToolApprovalBatcher({
    permissions: () => ({ workspaceIO: io, mode: 'acceptEdits', projectDir: '/project', additionalDirs: [], sessionAllowedTools: [] }),
    setStatus: () => {}, applySuggestion: () => assert.fail('取消后不能保存授权'),
    requestApproval: async () => assert.fail('取消后不能请求审批'),
  })
  const result = await batcher.authorize(writeFileTool, { path: 'file', content: 'x' }, {
    workspaceIO: io, projectDir: '/project', additionalDirs: [], abortSignal: controller.signal,
  }, 'cancelled')
  assert.equal(result.approved, false)
})
