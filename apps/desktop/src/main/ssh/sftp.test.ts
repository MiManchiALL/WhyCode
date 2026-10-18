import assert from 'node:assert/strict'
import { access, mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { it, type TestContext } from 'node:test'
import type { SFTPWrapper } from 'ssh2'
import { isUnknownWorkspaceOutcome } from '@whycode/core'
import { createSftpFileSystem } from './sftp.ts'
import { sshFixture } from './ssh-test-fixture.ts'

async function withSftp(t: TestContext, run: (sftp: SFTPWrapper, local: string, remote: string) => Promise<void>) {
  const env = await sshFixture(t)
  await env.store.trust(env.id, env.fingerprint)
  await env.connections.withFiles(env.id, async (_fs, _home, client) => {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((error, value) => error ? reject(error) : resolve(value)))
    try { await run(sftp, env.root, env.remoteRoot) }
    finally { sftp.end() }
  })
}

for (const afterFailure of ['empty', 'removed', 'new-file'] as const) {
  it(`SFTP rmdir 非空失败与并发清理交错：${afterFailure}`, { timeout: 15_000 }, async t => {
    await withSftp(t, async (sftp, local, remote) => {
      const directory = join(local, 'scratch')
      const marker = join(directory, 'old.txt')
      await mkdir(directory)
      await writeFile(marker, 'old')
      const remove = sftp.rmdir.bind(sftp)
      let calls = 0
      t.mock.method(sftp, 'rmdir', ((path, done) => {
        calls++
        if (calls === 2 && afterFailure === 'new-file') {
          void writeFile(join(directory, 'new.txt'), 'keep').then(() => remove(path, done), done)
          return
        }
        remove(path, error => {
          if (calls !== 1 || !error) { done(error); return }
          // 先取得真实 SFTP 非空失败，再让另一任务清理，最后交付原失败回包。
          void unlink(marker).then(async () => {
            if (afterFailure === 'removed') await rmdir(directory)
            done(error)
          }).catch(done)
        })
      }) satisfies SFTPWrapper['rmdir'])
      const fs = createSftpFileSystem(sftp)
      if (afterFailure === 'empty') await fs.rmdir(`${remote}/scratch`)
      else await assert.rejects(fs.rmdir(`${remote}/scratch`), { code: afterFailure === 'removed' ? 'ENOENT' : 'ENOTEMPTY' })
      assert.equal(calls, afterFailure === 'removed' ? 1 : 2)
      if (afterFailure === 'new-file') assert.equal(await readFile(join(directory, 'new.txt'), 'utf8'), 'keep')
      else await assert.rejects(access(directory), { code: 'ENOENT' })
    })
  })
}

it('SFTP rmdir 保留非空目录及文件，不重试删除', async t => {
  await withSftp(t, async (sftp, local, remote) => {
    await mkdir(join(local, 'scratch'))
    await writeFile(join(local, 'scratch/keep.txt'), 'keep')
    const remove = t.mock.method(sftp, 'rmdir')
    await assert.rejects(createSftpFileSystem(sftp).rmdir(`${remote}/scratch`), { code: 'ENOTEMPTY' })
    assert.equal(remove.mock.callCount(), 1)
    assert.equal(await readFile(join(local, 'scratch/keep.txt'), 'utf8'), 'keep')
  })
})

for (const code of [3, 4, 7]) {
  it(`SFTP rmdir 不掩盖持续失败、权限或连接错误：${code}`, async t => {
    await withSftp(t, async (sftp, local, remote) => {
      await mkdir(join(local, 'scratch'))
      const remove = t.mock.method(sftp, 'rmdir', ((_path, done) => done(Object.assign(new Error('拒绝删除'), { code }))) satisfies SFTPWrapper['rmdir'])
      const pending = createSftpFileSystem(sftp).rmdir(`${remote}/scratch`)
      if (code === 7) await assert.rejects(pending, isUnknownWorkspaceOutcome)
      else await assert.rejects(pending, { code: code === 3 ? 'EACCES' : 'EIO' })
      assert.equal(remove.mock.callCount(), code === 4 ? 2 : 1)
      await access(join(local, 'scratch'))
    })
  })
}
