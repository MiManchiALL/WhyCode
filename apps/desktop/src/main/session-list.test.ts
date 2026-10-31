import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { localWorkspace, type SessionSummary } from '@whycode/core'
import { projectSessionListItems, projectSidebarProjects } from './session-list.ts'
import { ProjectStore } from './project-store.ts'
import { SshConnections } from './ssh/connections.ts'
import { SshConnectionStore } from './ssh/store.ts'
import type { SidebarProject } from '../shared/projects.ts'

describe('projectSessionListItems', () => {
  it('置顶项保留手动顺序，最近项保留事实源时间顺序', () => {
    const summaries = [summary('newest', 3), summary('middle', 2), summary('oldest', 1)]
    const items = projectSessionListItems(
      summaries,
      [],
      null,
      ['oldest', 'newest'],
      () => false,
    )

    assert.deepEqual(items.map((item) => item.sessionId), ['oldest', 'newest', 'middle'])
    assert.deepEqual(items.map((item) => item.pinned), [true, true, false])
  })

  it('从已加载运行时和完成通知投影动态标记', () => {
    const items = projectSessionListItems(
      [summary('running', 2), summary('finished', 1)],
      [{ sessionId: 'running', busy: true }],
      'running',
      [],
      (sessionId) => sessionId === 'finished',
    )

    assert.deepEqual(items.map(({ sessionId, isCurrent, running, hasUnreadCompletion }) => ({
      sessionId,
      isCurrent,
      running,
      hasUnreadCompletion,
    })), [
      { sessionId: 'running', isCurrent: true, running: true, hasUnreadCompletion: false },
      { sessionId: 'finished', isCurrent: false, running: false, hasUnreadCompletion: true },
    ])
  })
})

it('SSH 改名通知后所有已登记项目读取新名称，断线和重启不依赖重新添加项目', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-sidebar-names-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const connectionPath = join(root, 'ssh-connections.json')
  const projectPath = join(root, 'projects.json')
  const codec = { isAvailable: () => false, encrypt: () => { throw new Error('不应加密') }, decrypt: () => { throw new Error('不应解密') } }
  const store = new SshConnectionStore(connectionPath, codec)
  const connections = new SshConnections(store, root)
  t.after(() => connections.close())
  const connection = await connections.save({ name: '原名称', host: 'example.test', port: 22,
    username: 'user', authentication: 'agent', rememberSecret: false })
  await store.trust(connection.id, 'SHA256:fixture-key')
  const target = [...(await connections.configuredTargets()).keys()][0]!
  const projects = new ProjectStore(projectPath)
  await projects.initialize()
  const binding = { mode: 'ssh' as const, target, label: '原名称', workingDirectory: '/project' }
  const first = await projects.addRemote(binding)
  await projects.addRemote({ ...binding, workingDirectory: '/another' })
  await projects.rename(first.id, '用户自定义项目名')
  await projects.attachSession(randomUUID(), binding)
  const originalProjects = projects.list()
  const originalBytes = await readFile(projectPath, 'utf8')
  const snapshots: Promise<SidebarProject[]>[] = []
  connections.on('changed', () => {
    snapshots.push(connections.configuredTargets().then(current => projectSidebarProjects(projects.list(), current)))
  })

  await connections.save({ ...connection, name: '新名称' })
  const expected = originalProjects.map(project => ({ ...project, remote: { ...project.remote!, label: '新名称' } }))
  assert.equal(snapshots.length, 1)
  assert.deepEqual(await snapshots[0], expected)
  assert.equal(connections.status(connection.id), 'disconnected')
  assert.equal(await connections.connectionIdForTarget(target), connection.id)
  assert.equal(await readFile(projectPath, 'utf8'), originalBytes)

  await assert.rejects(connections.save({ ...connection, name: ' ' }))
  assert.equal(snapshots.length, 1)
  const restartedConnections = new SshConnections(new SshConnectionStore(connectionPath, codec), root)
  t.after(() => restartedConnections.close())
  const restartedProjects = new ProjectStore(projectPath)
  await restartedProjects.initialize()
  assert.deepEqual(projectSidebarProjects(restartedProjects.list(), await restartedConnections.configuredTargets()), expected)
})

it('项目连接名称按完整服务器身份匹配，本地及已移除连接的项目保留登记信息', () => {
  const target = 'ssh:user@example.test:22#SHA256:first'
  const projects: SidebarProject[] = [
    { id: 'local', name: '本地项目', directory: '/local', sessionIds: [] },
    { id: 'remote', name: '远端项目', directory: '/project', sessionIds: ['session'], remote: { target, label: '登记名称' } },
    { id: 'other-user', name: '其它账户', directory: '/project', sessionIds: [], remote: { target: target.replace('user@', 'other@'), label: '登记名称' } },
    { id: 'other-key', name: '其它服务器', directory: '/project', sessionIds: [], remote: { target: target.replace('#SHA256:first', '#SHA256:other'), label: '登记名称' } },
  ]
  const original = structuredClone(projects)
  const result = projectSidebarProjects(projects, new Map([[target, { name: '当前连接名' }]]))
  assert.deepEqual(result, projects.map(project => project.id === 'remote'
    ? { ...project, remote: { target, label: '当前连接名' } } : project))
  assert.deepEqual(projects, original)
  assert.deepEqual(projectSidebarProjects(projects, new Map()), projects)
})

function summary(sessionId: string, order: number): SessionSummary {
  return {
    sessionId,
    title: sessionId,
    lastUserText: sessionId,
    createdAt: new Date(order).toISOString(),
    updatedAt: new Date(order).toISOString(),
    resumable: true,
    workspace: localWorkspace(process.cwd()),
    modelId: 'deepseek:deepseek-flash',
    referencedModelIds: ['deepseek:deepseek-flash'],
    reasoningEffort: 'default',
    status: 'idle',
  }
}
