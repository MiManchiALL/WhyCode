import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, access, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { localWorkspaceIO, type SkillSummary } from '@whycode/core'
import { readReady, WorkspaceDependencies } from './index.ts'
import type { SshConnections } from '../ssh/connections.ts'
import { environmentRoot } from './remote.ts'
import { runDependencyProcess } from './process.ts'
import { cleanupRemoteComponent, prepareRemoteComponent, ENVIRONMENT_OWNER } from '../ssh/component.ts'

test('同名用户 Skill 和只读角色不触发 Office 安装或声明环境就绪', async () => {
  const dependencies = new WorkspaceDependencies('absent-resources', 'absent-cache', {} as SshConnections)
  const skill: SkillSummary = { id: `skill:${'a'.repeat(64)}`, scope: 'system', name: 'documents', description: 'Office',
    path: join(tmpdir(), 'documents/SKILL.md'), rootPath: join(tmpdir(), 'documents') }
  const context = { canExecute: true, abortSignal: new AbortController().signal }
  for (const scope of ['project', 'user'] as const) {
    assert.equal(await dependencies.prepareSkill({ ...skill, scope }, context), null)
  }
  assert.equal(await dependencies.prepareSkill({ ...skill, name: 'other-skill' }, context), null)
  const disabled = await dependencies.prepareSkill(skill, { ...context, canExecute: false })
  assert.match(disabled!, /不能执行命令，未准备/)
  assert.doesNotMatch(disabled!, /"node"|已在.*准备/)
})

test('依赖取消会终止子进程，失败输出有界并保留原因', async () => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 300)
  try {
    await assert.rejects(runDependencyProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      process.cwd(), controller.signal), /已取消/)
  } finally { clearTimeout(timer) }
  await assert.rejects(runDependencyProcess(process.execPath, ['-e', "process.stderr.write('x'.repeat(30000)+'END'); process.exit(3)"],
    process.cwd(), new AbortController().signal), error => {
      assert.match((error as Error).message, /3.*x.*END/s)
      assert.ok((error as Error).message.length < 17000)
      return true
    })
})

test('归属不明、链接或不完整环境拒绝复用，清理只触及受管 Office 目录', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-dependencies-'))
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir(), 'whycode-dependencies-')))
    await rm(root, { recursive: true, force: true })
  })
  const home = root.replaceAll('\\', '/')
  const component = await prepareRemoteComponent(localWorkspaceIO.fs, home)
  const environment = component.directory + '/office'
  // 本地 IO 的路径规则用于隔离检查；生产 SSH 使用同样的 lstat/归属检查。
  await environmentRoot(localWorkspaceIO, environment)
  await writeFile(environment + '/.owner', 'foreign')
  await assert.rejects(environmentRoot(localWorkspaceIO, environment), /归属/)
  let removed = false
  const remove = async (path: string) => { assert.equal(path, environment); await rm(path, { recursive: true }); removed = true }
  await assert.rejects(cleanupRemoteComponent(localWorkspaceIO.fs, component.directory, remove), /归属/)
  assert.equal(removed, false)
  await writeFile(environment + '/.owner', ENVIRONMENT_OWNER)
  await mkdir(environment + '/incomplete')
  assert.equal(await readReady(localWorkspaceIO, environment + '/missing', 'version'), false)
  await assert.rejects(readReady(localWorkspaceIO, environment + '/incomplete', 'version'), /不完整/)
  await mkdir(root + '/project')
  await writeFile(root + '/project/keep', 'data')
  await symlink(root + '/project', environment + '/link', process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(readReady(localWorkspaceIO, environment + '/link', 'version'), /普通目录/)
  await cleanupRemoteComponent(localWorkspaceIO.fs, component.directory, remove)
  assert.equal(removed, true)
  await access(root + '/project/keep')
  await assert.rejects(access(component.directory), { code: 'ENOENT' })
})
