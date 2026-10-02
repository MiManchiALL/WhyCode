import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, rm, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { SkillCatalogService, installSystemSkills } from '@whycode/core'
import { sshFixture } from './ssh-test-fixture.ts'
import { SshSkillSync } from './skill-sync.ts'
import { ModifiedSshSkillsError } from './skill-remote.ts'
import { SshConnections, SshCredentialsRequiredError } from './connections.ts'
import { SshConnectionStore } from './store.ts'

async function localSkill(home: string, name: string, content = '初始内容') {
  const root = join(home, '.whycode', 'skills', name)
  await mkdir(join(root, 'references'), { recursive: true })
  await writeFile(join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: 用于测试完整资源同步\n---\n${content}\n`)
  await writeFile(join(root, 'references', '中文资料.txt'), content)
  await writeFile(join(root, 'empty.txt'), '')
  return root
}

test('新连接只初始化内置 Skill 一次；清理和重启后不自动补回，手动同步仍可恢复', async t => {
  const env = await sshFixture(t, 'protocol')
  const home = join(env.root, 'local-home')
  await localSkill(home, 'mine')
  await installSystemSkills(home)
  await localSkill(env.root, 'documents', '服务器原有用户 Skill')
  const sync = new SshSkillSync(env.connections, home, () => {})
  await env.connections.connect(env.id, env.fingerprint)
  await sync.initialize(env.id)
  assert.ok(sync.job(env.id)?.results.every(item => item.ok))
  const rows = (await sync.list(env.id)).rows
  const builtin = rows.filter(row => row.id.startsWith('.system/')).map(row => row.id)
  assert.equal(builtin.length, 7)
  assert.ok(rows.filter(row => builtin.includes(row.id)).every(row => row.status === 'same'))
  assert.equal(rows.find(row => row.id === 'mine')!.status, 'missing')
  const catalog = new SkillCatalogService({ homeDir: env.remoteRoot, workspaceIO: env.connections.host(env.id).io })
  assert.equal((await catalog.list(null)).skills.filter(skill => skill.scope === 'system').length, 7)
  await sync.clean(env.id, builtin, [])
  await assert.rejects(access(join(env.root, '.whycode/skills/.system')), { code: 'ENOENT' })
  env.connections.disconnect(env.id)
  await env.connections.connect(env.id)
  const restarted = new SshSkillSync(env.connections, home, () => {})
  await restarted.initialize(env.id)
  assert.equal(restarted.job(env.id), undefined)
  await assert.rejects(access(join(env.root, '.whycode/skills/.system')), { code: 'ENOENT' })
  const restored = await restarted.sync(env.id, [...builtin, 'mine'])
  assert.ok(restored.results.every(item => item.ok))
  assert.match(await readFile(join(env.root, '.whycode/skills/documents/SKILL.md'), 'utf8'), /服务器原有/)
  await env.connections.remove(env.id, { cleanSkills: true })
  await assert.rejects(access(join(env.root, '.whycode/skills/.system')), { code: 'ENOENT' })
  await access(join(env.root, '.whycode/skills/documents/SKILL.md'))
})

test('SSH Skill 同步完整目录、更新未改副本、保护冲突，并可离线清空包括远端孤立副本', async t => {
  const env = await sshFixture(t, 'protocol')
  const home = join(env.root, 'local-home')
  const source = await localSkill(home, 'alpha')
  await writeFile(join(source, 'image.bin'), Buffer.from([0, 127, 128, 255]))
  await mkdir(join(source, 'empty-directory'))
  await localSkill(home, 'beta')
  let changes = 0
  const sync = new SshSkillSync(env.connections, home, () => { changes++ })
  await env.connections.connect(env.id, env.fingerprint)
  const listing = await sync.list(env.id)
  assert.deepEqual(listing.rows.map(row => row.status), ['missing', 'missing'])
  assert.equal((await sync.sync(env.id, ['alpha', 'beta'])).results.every(item => item.ok), true)
  assert.ok(changes >= 4)
  const destination = join(env.root, '.whycode/skills/alpha')
  assert.equal(await readFile(join(destination, 'references/中文资料.txt'), 'utf8'), '初始内容')
  assert.equal(await readFile(join(destination, 'empty.txt'), 'utf8'), '')
  assert.deepEqual(await readFile(join(destination, 'image.bin')), Buffer.from([0, 127, 128, 255]))
  await access(join(destination, 'empty-directory'))
  const host = env.connections.host(env.id)
  const catalog = new SkillCatalogService({ homeDir: env.remoteRoot, workspaceIO: host.io })
  assert.deepEqual((await catalog.list(null)).skills.map(item => item.name), ['alpha', 'beta'])
  assert.equal((await sync.list(env.id)).rows[0]!.status, 'same')

  await writeFile(join(source, 'references/中文资料.txt'), '本地更新')
  assert.equal((await sync.list(env.id)).rows[0]!.status, 'update')
  assert.equal((await sync.sync(env.id, ['alpha'])).results[0]!.ok, true)
  assert.equal(await readFile(join(destination, 'references/中文资料.txt'), 'utf8'), '本地更新')
  await writeFile(join(destination, 'references/中文资料.txt'), '服务器修改')
  assert.equal((await sync.list(env.id)).rows[0]!.status, 'conflict')
  assert.equal((await sync.sync(env.id, ['alpha'])).results[0]!.ok, false)
  await assert.rejects(sync.clean(env.id, ['alpha'], []), ModifiedSshSkillsError)
  assert.equal(await readFile(join(destination, 'references/中文资料.txt'), 'utf8'), '服务器修改')

  // 本机目录和远端正文丢失都不丢清理入口。
  await rm(join(home, '.whycode/skills/beta'), { recursive: true })
  await rm(join(env.root, '.whycode/skills/beta/SKILL.md'))
  const orphan = (await sync.list(env.id)).rows.find(row => row.id === 'beta')!
  assert.equal(orphan.local, false); assert.equal(orphan.managed, true); assert.equal(orphan.modified, true)
  await env.connections.cleanup(env.id)
  assert.equal(env.connections.isConnected(env.id), false)
  const commands = env.commands.length
  const cleaned = await sync.clean(env.id, ['alpha', 'beta'], ['alpha', 'beta'])
  assert.equal(cleaned.results.every(item => item.ok), true)
  assert.equal(env.commands.length, commands)
  await assert.rejects(access(join(env.root, '.whycode')), { code: 'ENOENT' })
  assert.equal(env.connections.status(env.id), 'disconnected')
})

test('删除连接可保留远端修改；原有 Skill 与项目、临时目录不被清理', async t => {
  const env = await sshFixture(t, 'protocol')
  const home = join(env.root, 'local-home')
  await localSkill(home, 'alpha'); await localSkill(home, 'beta')
  const sync = new SshSkillSync(env.connections, home, () => {})
  await env.connections.connect(env.id, env.fingerprint)
  await sync.sync(env.id, ['alpha', 'beta'])
  await localSkill(env.root, 'native')
  await writeFile(join(env.root, '.whycode/skills/beta/empty.txt'), '保留')
  await mkdir(join(env.root, '.cache/whycode-scratch/session/Main'), { recursive: true })
  await writeFile(join(env.root, '.cache/whycode-scratch/session/Main/file'), '工作文件')
  await assert.rejects(env.connections.remove(env.id, { cleanSkills: true }), ModifiedSshSkillsError)
  assert.equal((await env.store.list()).length, 1)
  assert.equal(await readFile(join(env.root, '.whycode/skills/beta/empty.txt'), 'utf8'), '保留')
  const preserved = await env.connections.remove(env.id, { cleanSkills: true, keepModified: ['beta'] })
  assert.deepEqual(preserved, ['beta'])
  assert.equal((await env.store.list()).length, 0)
  await assert.rejects(access(join(env.root, '.whycode/skills/alpha')), { code: 'ENOENT' })
  await access(join(env.root, '.whycode/skills/native/SKILL.md'))
  await access(join(env.root, '.whycode/skills/beta/empty.txt'))
  await access(join(env.root, '.cache/whycode-scratch/session/Main/file'))
  await access(join(env.root, 'project'))
})

test('远端原有同名目录不接管，连接配置显式本地删除不会访问远端', async t => {
  const env = await sshFixture(t, 'protocol')
  const home = join(env.root, 'local-home')
  await localSkill(home, 'alpha'); await localSkill(env.root, 'alpha', '原有内容')
  const nested = await localSkill(home, 'alpha/nested')
  await writeFile(join(nested, 'SKILL.md'), '---\nname: nested\ndescription: 嵌套冲突\n---\n正文')
  // 本机只选择子目录；远端已有父级 Skill 不能被注入资源。
  await rm(join(home, '.whycode/skills/alpha/SKILL.md'))
  const sync = new SshSkillSync(env.connections, home, () => {})
  await env.connections.connect(env.id, env.fingerprint)
  const row = (await sync.list(env.id)).rows.find(item => item.id === 'alpha/nested')!
  assert.equal(row.status, 'conflict'); assert.equal(row.managed, false)
  await assert.rejects(sync.clean(env.id, ['alpha'], ['alpha']), /不属于/)
  env.connections.disconnect(env.id)
  const commands = env.commands.length
  await env.connections.removeLocal(env.id)
  assert.equal((await env.store.list()).length, 0)
  assert.equal(env.commands.length, commands)
  assert.match(await readFile(join(env.root, '.whycode/skills/alpha/SKILL.md'), 'utf8'), /原有内容/)
})

test('后台任务快照跨界面保留，同账号重复操作和组件清理不会与上传交错', async t => {
  const env = await sshFixture(t, 'protocol')
  const home = join(env.root, 'local-home')
  await localSkill(home, 'alpha')
  const sync = new SshSkillSync(env.connections, home, () => {})
  await env.connections.connect(env.id, env.fingerprint)
  const port = await env.addEndpoint()
  const alias = await env.store.save({ ...(await env.store.get(env.id)).connection, id: undefined, name: '同一账号的其它入口', port, secret: (await env.store.get(env.id)).secret })
  await env.connections.connect(alias.id, env.fingerprint)
  const host = env.connections.host(env.id)
  const write = host.io.fs.writeFile
  let enter!: () => void
  let resume!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const continueWrite = new Promise<void>(resolve => { resume = resolve })
  host.io.fs.writeFile = async (file, data, options) => {
    if (file.endsWith('SKILL.md')) { enter(); await continueWrite }
    await write(file, data, options)
  }
  const task = sync.sync(env.id, ['alpha'])
  await entered
  try {
    assert.equal(sync.job(env.id)?.running, true)
    await assert.rejects(sync.sync(env.id, ['alpha']), /后台/)
    await assert.rejects(sync.sync(alias.id, ['alpha']), /后台/)
    await assert.rejects(env.connections.cleanup(alias.id, { cleanSkills: true }), /后台/)
    await assert.rejects(env.connections.save({ ...(await env.store.get(env.id)).connection, name: '改名' }), /正在处理/)
  } finally { resume() }
  assert.equal((await task).results[0]!.ok, true)
  assert.equal(sync.job(env.id)?.running, false)
})

test('重启丢失临时密码时保留副本和配置，补充凭据后可用 SFTP 清理', async t => {
  const env = await sshFixture(t, 'protocol')
  const home = join(env.root, 'local-home')
  await localSkill(home, 'alpha')
  await env.connections.connect(env.id, env.fingerprint)
  await new SshSkillSync(env.connections, home, () => {}).sync(env.id, ['alpha'])
  const saved = await env.store.get(env.id)
  env.connections.disconnect(env.id)
  const store = new SshConnectionStore(join(env.root, 'connections.json'), {
    isAvailable: () => false, encrypt: () => { throw new Error('此用例不保存密码') }, decrypt: () => { throw new Error('此用例不读取密码') },
  })
  const connections = new SshConnections(store, join(env.root, 'missing-resources'))
  const sync = new SshSkillSync(connections, home, () => {})
  t.after(() => connections.close())
  await assert.rejects(sync.clean(env.id, ['alpha'], []), SshCredentialsRequiredError)
  assert.equal((await store.list()).length, 1)
  assert.equal(sync.job(env.id)?.running, false)
  await access(join(env.root, '.whycode/skills/alpha/SKILL.md'))
  await connections.save({ ...saved.connection, secret: saved.secret })
  const commands = env.commands.length
  assert.equal((await sync.clean(env.id, ['alpha'], [])).results[0]!.ok, true)
  assert.equal(env.commands.length, commands)
  await assert.rejects(access(join(env.root, '.whycode')), { code: 'ENOENT' })
})

test('单次同步总量超限时整批拒绝，不提前发布部分 Skill', async t => {
  const env = await sshFixture(t, 'protocol')
  const home = join(env.root, 'local-home')
  for (const name of ['alpha', 'beta']) {
    const directory = await localSkill(home, name)
    await writeFile(join(directory, 'large.bin'), Buffer.alloc(11 * 1024 * 1024))
  }
  await env.connections.connect(env.id, env.fingerprint)
  const sync = new SshSkillSync(env.connections, home, () => {})
  await assert.rejects(sync.sync(env.id, ['alpha', 'beta']), /单次 20 MiB/)
  assert.equal(sync.job(env.id)?.results.filter(result => !result.ok).length, 2)
  await assert.rejects(access(join(env.root, '.whycode')), { code: 'ENOENT' })
})
