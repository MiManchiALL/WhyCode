import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import ssh2, { type Connection } from 'ssh2'
import type { TestContext } from 'node:test'
import { serveTestSftp } from './sftp-test-fixture.ts'
import { SshConnections } from './connections.ts'
import { SshConnectionStore } from './store.ts'

const { Server, utils } = ssh2

export async function sshFixture(t: TestContext, linux = false) {
  const temporaryRoot = await realpath(tmpdir())
  const root = await mkdtemp(join(temporaryRoot, 'whycode-ssh-'))
  const remoteRoot = process.platform === 'win32' ? `/mnt/${root[0]!.toLowerCase()}${root.slice(2).replaceAll('\\', '/')}` : root
  // ssh2 的 Ed25519 生成器会剥离公钥前导零，导致随机产生无法解析的测试密钥。
  const keys = utils.generateKeyPairSync('ecdsa', { bits: 256 })
  const keyPassword = randomBytes(16).toString('hex')
  const clientKeys = utils.generateKeyPairSync('ecdsa', { bits: 256, passphrase: keyPassword, cipher: 'aes256-cbc', rounds: 8 })
  const clientKey = utils.parseKey(clientKeys.public)
  assert.ok(!(clientKey instanceof Error))
  const keyPath = join(root, 'identity')
  await writeFile(keyPath, clientKeys.private)
  const parsed = utils.parseKey(keys.private)
  assert.ok(!(parsed instanceof Error))
  const fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`
  const password = randomBytes(24).toString('hex')
  const clients = new Set<Connection>()
  const children = new Set<ChildProcess>()
  const commands: string[] = []
  const server = new Server({ hostKeys: [keys.private] }, client => {
    clients.add(client)
    client.on('error', () => {})
    client.once('close', () => clients.delete(client))
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === password) ctx.accept()
      else if (ctx.method === 'publickey' && ctx.username === 'fixture' && ctx.key.data.equals(clientKey.getPublicSSH())
        && (!ctx.signature || clientKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)) ctx.accept()
      else ctx.reject()
    })
    client.on('session', accept => {
      const session = accept()
      session.on('sftp', acceptSftp => serveTestSftp(acceptSftp(), root, remoteRoot))
      session.on('exec', (acceptExec, _reject, info) => {
        const channel = acceptExec(); commands.push(info.command)
        if (info.command === 'uname -s; uname -m') { channel.write('Linux\nx86_64\n'); channel.exit(0); channel.end(); return }
        if (!linux) { channel.exit(1); channel.end(); return }
        const child = process.platform === 'win32'
          ? spawn('wsl.exe', ['-d', 'Ubuntu', '--exec', '/bin/sh', '-c', info.command], { windowsHide: true })
          : spawn('/bin/sh', ['-c', info.command])
        children.add(child)
        channel.pipe(child.stdin); child.stdout.pipe(channel, { end: false }); child.stderr.pipe(channel.stderr, { end: false })
        child.stdin.on('error', () => {})
        child.once('close', code => { children.delete(child); channel.exit(code ?? 1); channel.end() })
        channel.once('close', () => child.stdin.end())
      })
    })
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const store = new SshConnectionStore(join(root, 'connections.json'), {
    isAvailable: () => true,
    encrypt: value => Buffer.from(value).toString('base64'),
    decrypt: value => Buffer.from(value, 'base64').toString(),
  })
  const connections = new SshConnections(store, resolve('resources/remote'))
  const saved = await store.save({ name: '隔离测试', host: '127.0.0.1', port: address.port, username: 'fixture', authentication: 'password', secret: password, rememberSecret: false })
  const project = `${remoteRoot}/project`
  await mkdir(join(root, 'project'))
  t.after(async () => {
    connections.close()
    for (const client of clients) client.end()
    for (const child of children) child.stdin?.end()
    await Promise.all([...children].map(child => once(child, 'close')))
    await new Promise<void>(done => server.close(() => done()))
    assert.ok(resolve(root).startsWith(resolve(temporaryRoot, 'whycode-ssh-')))
    await rm(root, { recursive: true, force: true })
  })
  return { root, remoteRoot, project, connections, store, id: saved.id, fingerprint, commands, clients, keyPath, keyPassword }
}
