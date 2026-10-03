import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join, posix } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { it } from 'node:test'
import type { SFTPWrapper } from 'ssh2'
import { BUILTIN_TOOLS, CheckpointManager, isUnknownWorkspaceOutcome, type ToolContext, type WorkspaceIO } from '@whycode/core'
import { createSftpFileSystem } from './sftp.ts'
import { sshFixture } from './ssh-test-fixture.ts'

it('真实 SFTP 大文件删除与检查点恢复保留全部字节，不调用整文件读取或写入', { timeout: 30_000 }, async t => {
  const env = await sshFixture(t)
  await env.store.trust(env.id, env.fingerprint)
  await env.connections.withFiles(env.id, async fs => {
    const path = `${env.project}/large.tmp`
    const bytes = Buffer.alloc(1024 * 1024 + 13, 255)
    bytes[0] = 0
    await fs.writeFile(path, bytes)
    const io: WorkspaceIO = { identity: 'sftp-fixture', platform: 'linux', path: posix, fs: { ...fs,
      readFile: async () => assert.fail('不得下载完整文件'),
      writeFile: async () => assert.fail('不得缓存完整恢复内容'),
    } }
    const ctx: ToolContext = { workspaceIO: io, projectDir: env.project, additionalDirs: [], abortSignal: new AbortController().signal }
    const tool = BUILTIN_TOOLS.find(item => item.name === 'DeleteFile')!
    const manager = new CheckpointManager({ sessionId: randomUUID(), sessionDir: join(env.root, 'journal'), workspaceIO: io })
    const prepared = await manager.prepare('delete', 'turn', { kind: 'exact-files', paths: [path] })
    assert.ok(prepared, manager.disabled ?? '检查点创建失败')
    assert.equal(await tool.renderDiff!({ paths: [path] }, ctx), '')
    const result = await tool.execute({ paths: [path] }, ctx)
    assert.equal(result.isError, false)
    assert.deepEqual(result.fileChanges, [])
    await assert.rejects(fs.stat(path), { code: 'ENOENT' })
    assert.ok(await manager.finalize(prepared))
    const restored = await manager.restore('delete', 'files')
    assert.equal(restored.ok, true, restored.error)
    assert.deepEqual(await fs.readFile(path), bytes)
  })
  assert.equal(env.commands.length, 0)
})

it('SFTP 读写流将断线传递为结果未知，将缺失路径传递为文件错误', async () => {
  const disconnected = () => Object.assign(new Error('Connection lost'), { code: 7 })
  const fs = createSftpFileSystem({
    createReadStream: () => Readable.from((async function* () { throw disconnected() })()),
    createWriteStream: () => new Writable({ write(_chunk, _encoding, callback) { callback(disconnected()) } }),
  } as unknown as SFTPWrapper)
  await assert.rejects(pipeline(fs.createReadStream('/file'), new Writable({ write(_chunk, _encoding, callback) { callback() } })), isUnknownWorkspaceOutcome)
  await assert.rejects(pipeline(Readable.from([Buffer.from('data')]), fs.createWriteStream('/file')), isUnknownWorkspaceOutcome)
  const missing = createSftpFileSystem({
    createWriteStream: () => new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error('No such file'), { code: 2 })) } }),
  } as unknown as SFTPWrapper)
  await assert.rejects(pipeline(Readable.from(['data']), missing.createWriteStream('/missing/file')), { code: 'ENOENT' })
})
