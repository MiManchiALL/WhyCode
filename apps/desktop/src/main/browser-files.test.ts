import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserFiles } from './browser-files.ts'
import { browserDisplayUrl } from '../shared/browser.ts'

it('本地页加载相对资源并保留目录 origin，租约不能跨标签借用或越过目录', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-browser-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'site', 'assets'), { recursive: true })
  await writeFile(join(root, 'site', 'index.html'), '<h1>Site</h1>')
  await writeFile(join(root, 'site', 'assets', 'app.js'), 'window.loaded=true')
  await writeFile(join(root, 'secret.txt'), 'outside')
  const files = new BrowserFiles()
  const input = pathToFileURL(join(root, 'site', 'index.html')).href + '?v=2#start'
  const url = files.open('a', input)
  assert.equal(browserDisplayUrl(url), input)
  assert.equal(files.allows('a', url), true)
  assert.equal(files.allows('b', url), false)
  assert.equal(await files.resolve(new URL('./assets/app.js', url).href), await realpath(join(root, 'site', 'assets', 'app.js')))
  assert.equal(files.allows('a', new URL('../secret.txt', url).href), false)
  await assert.rejects(files.resolve(new URL('../secret.txt', url).href))
  assert.equal(files.open('b', input), url)
  files.release('a')
  assert.equal(files.allows('a', url), false)
  assert.equal(files.allows('b', url), true)
  files.release('b')
  await assert.rejects(files.resolve(url))
  assert.equal(files.open('c', input), url)
})

it('本地资源拒绝越界目录链接、目录本身和删除后文件；重建后可读取', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-browser-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'site'))
  await mkdir(join(root, 'outside'))
  await writeFile(join(root, 'outside', 'secret.txt'), 'outside')
  await symlink(join(root, 'outside'), join(root, 'site', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const files = new BrowserFiles()
  const file = join(root, 'site', 'index.html')
  const url = files.open('a', pathToFileURL(file).href)
  await assert.rejects(files.resolve(new URL('./linked/secret.txt', url).href))
  await assert.rejects(files.resolve(new URL('./', url).href))
  await assert.rejects(files.resolve(url))
  await writeFile(file, 'created')
  assert.equal(await files.resolve(url), await realpath(file))
  await rm(file)
  await assert.rejects(files.resolve(url))
  await writeFile(file, 'recreated')
  assert.equal(await files.resolve(url), await realpath(file))
})

it('文件加载入口不接受网络网址、共享路径或未经宿主准备的内部地址', () => {
  const files = new BrowserFiles()
  for (const url of ['https://example.com', 'file://server/share/file.html', 'data:text/html,a', 'whycode-browser-file://id/a']) {
    assert.throws(() => files.open('a', url))
    assert.equal(files.allows('a', url), false)
  }
})

it('目录授权有界，同目录复用不占额度，关闭标签后释放额度', () => {
  const files = new BrowserFiles()
  const url = (index: number) => pathToFileURL(join(tmpdir(), 'browser-limit', String(index), 'index.html')).href
  for (let i = 0; i < 32; i++) files.open('a', url(i))
  assert.doesNotThrow(() => files.open('a', url(0)))
  assert.throws(() => files.open('a', url(32)))
  assert.doesNotThrow(() => files.open('b', url(32)))
  files.release('a')
  assert.doesNotThrow(() => files.open('a', url(32)))
})
