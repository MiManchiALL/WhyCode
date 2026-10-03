import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Duplex, PassThrough } from 'node:stream'
import type { Client } from 'ssh2'
import { localWorkspaceIO } from '@whycode/core'
import { sshFixture } from './ssh-test-fixture.ts'
import { readSkillTree, remoteSkillIO, skillTreeDigest } from './skill-files.ts'
import { remoteSkillDigest } from './skill-digest.ts'

test('远端摘要与完整目录摘要一致，资源不经 SFTP 下载且等长修改仍被发现', async t => {
  const env = await sshFixture(t, 'protocol')
  const directory = join(env.root, 'tree')
  await mkdir(join(directory, 'empty'), { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), '正文')
  await writeFile(join(directory, 'empty.txt'), '')
  const filename = "中文 don't $(printf x).bin"
  const bytes = Buffer.alloc(1024 * 1024, Buffer.from([0, 127, 128, 255]))
  await writeFile(join(directory, filename), bytes)
  const original = await readSkillTree(localWorkspaceIO, directory)
  await env.connections.connect(env.id, env.fingerprint)
  await env.connections.withFiles(env.id, async (fs, home, client) => {
    const io = remoteSkillIO({ ...fs, open: async () => { throw new Error('核对不应下载资源') } }, home, client)
    assert.equal(await skillTreeDigest(io, `${home}/tree`), original.digest)
    bytes[0] = 1
    await writeFile(join(directory, filename), bytes)
    assert.notEqual(await skillTreeDigest(io, `${home}/tree`), original.digest)
    assert.equal(await skillTreeDigest(io, `${home}/tree`), (await readSkillTree(localWorkspaceIO, directory)).digest)
  })
})

test('远端读取失败不能接受管道末端产生的不完整摘要', async t => {
  const env = await sshFixture(t, 'protocol')
  await env.connections.connect(env.id, env.fingerprint)
  await env.connections.withFiles(env.id, async (_fs, home, client) => {
    await assert.rejects(remoteSkillDigest(client, {
      bytes: 1, directories: [], files: [{ path: 'missing', absolute: `${home}/missing`, size: 1, mode: 0o600 }],
    }), /内容校验失败/)
  })
})

test('远端摘要停滞后报错并关闭执行通道', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const stream = new Duplex({ read() {}, write(_chunk, _encoding, done) { done() } })
  const channel = Object.assign(stream, {
    stderr: new PassThrough(), close: () => stream.destroy(),
  })
  const client = { exec: (_command: string, done: (error: null, value: typeof channel) => void) => done(null, channel) } as unknown as Client
  const pending = remoteSkillDigest(client, { bytes: 0, directories: [], files: [] })
  const failure = assert.rejects(pending, /内容校验超时/)
  await new Promise<void>(resolve => setImmediate(resolve))
  t.mock.timers.tick(30_000)
  await failure
  assert.equal(channel.destroyed, true)
})
