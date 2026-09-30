import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { it } from 'node:test'
import type { Client, ClientChannel } from 'ssh2'
import { localWorkspaceIO, type WorkspaceFileSystem } from '@whycode/core'
import { digest, provisionRemote, quoteShell } from './provision.ts'

it('远端校验只返回摘要，不下载组件；首次发布、重复连接与损坏校验保持一致', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-provision-'))
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir(), 'whycode-provision-')))
    await rm(root, { recursive: true, force: true })
  })
  const home = join(root, "home with ' quote").replaceAll('\\', '/')
  const resources = join(root, 'resources')
  await mkdir(resources)
  const commands: string[] = []
  const remoteFiles = new Map<string, string>()
  for (const [name, prefix] of [['whycode-remote-linux-x64', 'host'], ['ripgrep-linux-x64', 'rg']]) {
    const binary = Buffer.alloc(8192, prefix)
    await writeFile(join(resources, name!), binary)
    const file = posix.join(home, '.cache/whycode-remote', `${prefix}-${digest(binary)}`)
    remoteFiles.set(`sha256sum -- ${quoteShell(file)}`, file)
  }
  let checksumAvailable = true
  const client = {
    exec(command: string, done: (error: Error | undefined, channel: ClientChannel) => void) {
      commands.push(command)
      const channel = Object.assign(new PassThrough(), {
        stderr: new PassThrough(), close: () => channel.emit('close', 1),
      })
      done(undefined, channel as unknown as ClientChannel)
      void new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
        if (command === 'uname -s; uname -m') channel.emit('data', Buffer.from('Linux\nx86_64\n'))
        else if (checksumAvailable) {
          const file = remoteFiles.get(command)
          assert.ok(file, command)
          channel.emit('data', Buffer.from(`${digest(await readFile(file))}  ${file}\n`))
        } else { channel.emit('close', 127); return }
        channel.emit('close', 0)
      }).catch(error => channel.emit('error', error))
    },
  } as unknown as Client
  const uploads: string[] = []
  const fs: WorkspaceFileSystem = {
    ...localWorkspaceIO.fs,
    readFile: ((file: string, encoding?: 'utf8') => {
      assert.equal(posix.basename(file), '.owner', '组件二进制不能通过 SFTP 读回本机')
      return encoding ? localWorkspaceIO.fs.readFile(file, encoding) : localWorkspaceIO.fs.readFile(file)
    }) as WorkspaceFileSystem['readFile'],
    writeFile: async (file, data, options) => {
      if (file.endsWith('.tmp')) uploads.push(file)
      await localWorkspaceIO.fs.writeFile(file, data, options)
    },
  }
  const installed = await provisionRemote(client, fs, home, resources)
  assert.equal(uploads.length, 2)
  assert.equal(commands.filter(command => command.startsWith('sha256sum')).length, 2)
  commands.length = 0
  uploads.length = 0
  assert.deepEqual(await provisionRemote(client, fs, home, resources), installed)
  assert.equal(uploads.length, 0)
  assert.deepEqual(commands, ['uname -s; uname -m', ...remoteFiles.keys()])
  await writeFile(installed.executable, 'corrupted')
  await assert.rejects(provisionRemote(client, fs, home, resources), /校验失败/)
  checksumAvailable = false
  await assert.rejects(provisionRemote(client, fs, home, resources), /sha256sum/)
})
