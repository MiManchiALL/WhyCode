import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { localWorkspaceIO } from '@whycode/core'
import { GitRepository } from './git-repository.ts'
import { gitPushProxyArgs } from './git-proxy.ts'
import { mutateGitRepository } from './git-actions.ts'

async function fixture(t: TestContext, remote = 'https://fetch.invalid/repo.git') {
  const root = await mkdtemp(join(tmpdir(), 'whycode-git-proxy-test-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const directory = join(root, 'project')
  await mkdir(directory)
  const config = join(root, 'empty-git-config')
  await writeFile(config, '')
  const names = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY',
    'no_proxy', 'NO_PROXY', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']
  const previous = names.map(name => [name, process.env[name]] as const)
  for (const name of names) delete process.env[name]
  process.env.GIT_CONFIG_GLOBAL = config
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  const repo = new GitRepository(directory)
  const git = (args: string[]) => repo.text(args, '测试 Git', { readOnly: false })
  await git(['init', '-b', 'main'])
  await git(['remote', 'add', 'origin', remote])
  return { directory, repo, git }
}

test('系统代理转换为仅限当前命令的 URL 配置，保持首选线路与 SOCKS DNS 语义', async t => {
  const { repo, git } = await fixture(t)
  const url = 'https://fetch.invalid/repo.git'
  for (const [resolution, expected] of [
    ['PROXY 127.0.0.1:7890; DIRECT', 'http://127.0.0.1:7890'],
    ['HTTPS proxy.example:8443', 'https://proxy.example:8443'],
    ['SOCKS proxy.example:1080', 'socks4://proxy.example:1080'],
    ['SOCKS4 proxy.example:1080', 'socks4://proxy.example:1080'],
    ['SOCKS5 [::1]:1080', 'socks5h://[::1]:1080'],
    ['DIRECT; PROXY 127.0.0.1:7890', ''],
  ]) {
    const args = await gitPushProxyArgs(repo, 'origin', async actual => {
      assert.equal(actual, url)
      return resolution!
    })
    assert.equal((await git([...args, 'config', '--get-urlmatch', 'http.proxy', url])).trim(), expected)
    assert.equal((await repo.run(['config', '--get-urlmatch', 'http.proxy', url])).code, 1)
  }
  for (const resolution of ['', 'QUIC proxy.example:443; DIRECT']) {
    await assert.rejects(gitPushProxyArgs(repo, 'origin', async () => resolution), /无法使用系统代理/u)
  }
  await assert.rejects(gitPushProxyArgs(repo, 'origin', async () => { throw new Error('proxy resolution failed') }), /proxy resolution failed/u)
})

test('按展开后的全部推送地址解析，支持不同 URL 使用代理或直连', async t => {
  const { repo, git } = await fixture(t)
  await git(['config', 'url.https://push.invalid/.pushInsteadOf', 'https://fetch.invalid/'])
  const resolved: string[] = []
  const resolveProxy = async (url: string) => {
    resolved.push(url)
    return url.includes('direct.invalid') ? 'DIRECT' : 'PROXY 127.0.0.1:7890'
  }
  await gitPushProxyArgs(repo, 'origin', resolveProxy)
  assert.deepEqual(resolved.splice(0), ['https://push.invalid/repo.git'])
  await git(['config', '--add', 'remote.origin.pushurl', 'https://direct.invalid/one.git'])
  await git(['config', '--add', 'remote.origin.pushurl', 'alias:two.git'])
  await git(['config', 'url.https://push.invalid/.insteadOf', 'alias:'])
  const args = await gitPushProxyArgs(repo, 'origin', resolveProxy)
  assert.deepEqual(resolved, ['https://direct.invalid/one.git', 'https://push.invalid/two.git'])
  assert.equal((await git([...args, 'config', '--get-urlmatch', 'http.proxy', resolved[0]!])).trim(), '')
  assert.equal((await git([...args, 'config', '--get-urlmatch', 'http.proxy', resolved[1]!])).trim(), 'http://127.0.0.1:7890')
})

test('显式 Git 配置包括空值和对应协议环境变量优先于系统代理', async t => {
  const { repo, git } = await fixture(t)
  const unexpected = async () => { throw new Error('不应解析系统代理') }
  for (const key of ['remote.origin.proxy', 'http.proxy', 'http.https://fetch.invalid/.proxy']) {
    for (const value of ['', 'http://explicit.invalid:8000']) {
      await git(['config', key, value])
      assert.deepEqual(await gitPushProxyArgs(repo, 'origin', unexpected), [])
    }
    await git(['config', '--unset', key])
  }
  for (const name of ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
    process.env[name] = 'http://explicit.invalid:8000'
    assert.deepEqual(await gitPushProxyArgs(repo, 'origin', unexpected), [])
    delete process.env[name]
  }
  process.env.http_proxy = 'http://http-only.invalid:8000'
  const args = await gitPushProxyArgs(repo, 'origin', async () => 'DIRECT')
  assert.equal(args.length, 2)
  await git(['remote', 'set-url', 'origin', 'http://fetch.invalid/repo.git'])
  assert.deepEqual(await gitPushProxyArgs(repo, 'origin', unexpected), [])
})

test('SSH 工作区与非 HTTP 推送不读取本机代理，解析器不接收 URL 凭据', async t => {
  const { directory, repo, git } = await fixture(t)
  const unexpected = async () => { throw new Error('不应解析系统代理') }
  const remoteRepo = new GitRepository(directory, { ...localWorkspaceIO, identity: 'ssh:test' })
  t.mock.method(remoteRepo, 'run', () => { throw new Error('不应执行本机配置探测') })
  assert.deepEqual(await gitPushProxyArgs(remoteRepo, 'origin', unexpected), [])
  for (const url of ['git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo.git', directory]) {
    await git(['remote', 'set-url', 'origin', url])
    assert.deepEqual(await gitPushProxyArgs(repo, 'origin', unexpected), [])
  }
  await git(['remote', 'set-url', 'origin', 'https://user:test-password@push.invalid/repo.git'])
  const args = await gitPushProxyArgs(repo, 'origin', async url => {
    assert.equal(url, 'https://push.invalid/repo.git')
    return 'DIRECT'
  })
  assert.equal(args.some(arg => arg.includes('test-password')), false)
})

test('真实推送命令经过系统代理，代理失败不重试或改写仓库配置', async t => {
  const url = 'http://whycode-proxy-test.invalid/repo.git'
  const { directory, repo, git } = await fixture(t, url)
  await git(['config', 'user.name', 'Git Proxy Test'])
  await git(['config', 'user.email', 'proxy-test@example.invalid'])
  await writeFile(join(directory, 'test.txt'), 'proxy test\n')
  await git(['add', 'test.txt']); await git(['commit', '-m', 'initial'])
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url!)
    res.writeHead(502); res.end('proxy test rejection')
  })
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const info = await repo.info()
  await assert.rejects(mutateGitRepository(repo, {
    expectedHead: info.head, expectedBranch: info.branch, action: { kind: 'push', remote: 'origin' },
  }, async target => {
    assert.equal(target, url)
    return `PROXY 127.0.0.1:${address.port}; DIRECT`
  }), /502/u)
  assert.deepEqual(requests, [`${url}/info/refs?service=git-receive-pack`])
  assert.equal((await repo.info()).upstream, null)
  assert.equal((await repo.run(['config', '--get-urlmatch', 'http.proxy', url])).code, 1)
})
