import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { it, type TestContext } from 'node:test'
import { SshConnectionStore } from './store.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-ssh-store-'))
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir(), 'whycode-ssh-store-')))
    await rm(root, { recursive: true, force: true })
  })
  const file = join(root, 'connections.json')
  return { file, store: new SshConnectionStore(file, {
    isAvailable: () => true, encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString(),
  }) }
}

const input = { name: '服务器', host: 'example.test', port: 22, username: 'Lin', authentication: 'password' as const, rememberSecret: false }

it('首次 Skill 初始化机会原子消费，编辑与重启不会重新授权自动上传', async t => {
  const { file, store } = await fixture(t)
  const first = await store.save(input)
  assert.equal('initializeSkills' in first, false)
  const edited = await store.save({ ...first, name: '新名称' })
  assert.deepEqual(await Promise.all([store.takeSkillInitialization(edited.id), store.takeSkillInitialization(edited.id)]), [true, false])
  await store.save({ ...edited, name: '再次编辑' })
  assert.equal(await store.takeSkillInitialization(first.id), false)
  assert.equal(JSON.parse(await readFile(file, 'utf8'))[0].initializeSkills, undefined)
  await store.remove(first.id)
  assert.equal(await store.takeSkillInitialization((await store.save(input)).id), true)
})

it('连接名称和认证方式不产生新服务器，重复保存不改配置、凭据或信任', async t => {
  const { file, store } = await fixture(t)
  const first = await store.save({ ...input, secret: 'first-secret' })
  await store.trust(first.id, 'trusted-key')
  const bytes = await readFile(file, 'utf8')
  for (const changes of [{ name: 'another' }, { authentication: 'agent' as const }, { host: ' EXAMPLE.TEST. ' }]) {
    await assert.rejects(store.save({ ...input, ...changes, secret: 'other-secret' }), /该服务器账户已存在.*服务器/)
    assert.equal(await readFile(file, 'utf8'), bytes)
    assert.equal((await store.get(first.id)).secret, 'first-secret')
    assert.equal((await store.get(first.id)).connection.fingerprint, 'trusted-key')
  }
  const renamed = await store.save({ ...first, name: '新名字' })
  assert.equal(renamed.id, first.id)
  assert.equal((await store.get(first.id)).secret, 'first-secret')
})

it('编辑冲突和并发新增都在原子保存入口拒绝，端口及用户名大小写仍独立', async t => {
  const { store } = await fixture(t)
  const outcomes = await Promise.allSettled([store.save(input), store.save({ ...input, name: '重复项' })])
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1)
  const other = await store.save({ ...input, port: 2222 })
  await assert.rejects(store.save({ ...other, port: 22 }), /已存在/)
  assert.equal((await store.get(other.id)).connection.port, 2222)
  await store.save({ ...input, username: 'lin' })
  assert.equal((await store.list()).length, 3)
})

it('同一 IPv6 地址的括号、大小写和缩写不能绕过查重', async t => {
  const { store } = await fixture(t)
  await store.save({ ...input, host: '2001:db8::1' })
  await assert.rejects(store.save({ ...input, host: '[2001:0DB8:0:0:0:0:0:1]' }), /已存在/)
})
