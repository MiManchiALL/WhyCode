import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { it, type TestContext } from 'node:test'
import { WorkspaceFiles } from './workspace-files.ts'
import { DIRECTORY_PAGE_SIZE, MAX_TEXT_PREVIEW_BYTES, documentFormat, previewMediaType } from '../shared/workspace-files.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-file-browser-'))
  const workspace = join(root, 'project')
  const files = new WorkspaceFiles()
  await mkdir(workspace)
  t.after(async () => {
    files.closeOwner(1)
    files.closeOwner(2)
    assert.equal(resolve(root).startsWith(resolve(tmpdir(), 'whycode-file-browser-')), true)
    await rm(root, { recursive: true, force: true })
  })
  const open = (path: string, kind: 'file' | 'directory' = 'file', changed = (_id: string) => {}) => files.open(1, { runtimeId: 'a', kind, path }, workspace, changed)
  const document = async (name: string, text: string | Uint8Array) => {
    const path = join(workspace, name)
    await writeFile(path, text)
    const view = await open(path)
    assert.equal(view.kind, 'file')
    if (view.kind !== 'file') throw new Error('expected file')
    return view
  }
  return { root, workspace, files, open, document }
}

it('按层读取目录、目录优先并自然排序，分页无重复；缺失草稿目录不物化', async t => {
  const { workspace, open, files } = await fixture(t)
  await mkdir(join(workspace, 'folder'))
  await Promise.all(Array.from({ length: DIRECTORY_PAGE_SIZE + 2 }, (_, i) => writeFile(join(workspace, `file${i}.txt`), '')))
  const page = await open('', 'directory')
  assert.equal(page.kind, 'directory')
  if (page.kind !== 'directory') return
  assert.equal(page.entries.length, DIRECTORY_PAGE_SIZE)
  assert.equal(page.entries[0]?.name, 'folder')
  assert.equal(page.entries[2]?.name, 'file1.txt')
  const tail = await files.read(1, page.id, DIRECTORY_PAGE_SIZE)
  assert.equal(tail.kind, 'directory')
  if (tail.kind !== 'directory') return
  assert.equal(new Set([...page.entries, ...tail.entries].map(e => e.path)).size, page.total)
  await assert.rejects(files.read(1, page.id, -1), /读取位置/)
  const missing = join(workspace, 'pending')
  const draft = await files.open(2, { runtimeId: 'draft', kind: 'directory', path: '' }, missing, () => {})
  assert.equal(draft.kind === 'directory' && draft.missing, true)
  await assert.rejects(stat(missing), { code: 'ENOENT' })
  await mkdir(missing)
  const refreshed = await files.read(2, draft.id)
  assert.equal(refreshed.kind === 'directory' && refreshed.missing, false)
})

it('预览类型、文本上限、未知二进制与特殊扩展名按真实文件判定', async t => {
  const { document } = await fixture(t)
  assert.equal((await document('test.MD', '# Test')).format, 'markdown')
  assert.equal((await document('test.html', '<html>test</html>')).format, 'html')
  assert.equal((await document('test.PNG', new Uint8Array([137, 80, 78, 71]))).format, 'image')
  assert.equal((await document('test.pdf', '%PDF-1.7')).format, 'pdf')
  assert.equal((await document('test.docx', 'unknown')).url, null)
  assert.equal((await document('unknown', new Uint8Array([0, 255]))).url, null)
  assert.equal((await document('huge.txt', 'x'.repeat(MAX_TEXT_PREVIEW_BYTES + 1))).url, null)
  assert.equal((await document('empty.txt', '')).format, 'code')
  assert.equal(documentFormat('constructor'), 'code')
  assert.equal(previewMediaType('__proto__'), null)
})

it('隔离预览地址支持 HTML 相对资源、UTF-8 文件名、刷新版本和字节范围', async t => {
  const { document, files, workspace } = await fixture(t)
  const page = await document('预览 #.html', '<p>hello</p>')
  assert.ok(page.url)
  const response = await files.response(new Request(page.url))
  assert.equal(await response.text(), '<p>hello</p>')
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.match(response.headers.get('content-security-policy')!, /sandbox allow-scripts;/)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  await mkdir(join(workspace, 'assets'))
  await writeFile(join(workspace, 'assets', 'app.js'), '123456789')
  const asset = new URL('assets/app.js', page.url)
  const ranged = await files.response(new Request(asset, { headers: { Range: 'bytes=2-4' } }))
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers.get('content-range'), 'bytes 2-4/9')
  assert.equal(await ranged.text(), '345')
  assert.equal(await (await files.response(new Request(asset, { headers: { Range: 'bytes=-2' } }))).text(), '89')
  assert.equal((await files.response(new Request(asset, { headers: { Range: 'bytes=99-' } }))).status, 416)
  assert.equal(await (await files.response(new Request(asset, { method: 'HEAD' }))).text(), '')
  assert.equal((await files.response(new Request(asset, { method: 'POST' }))).status, 405)
  const refreshed = await files.read(1, page.id)
  assert.equal(refreshed.kind === 'file' && refreshed.url !== page.url, true)
})

it('目录不能越界；HTML 不能读取隐藏、非静态文件、路径转义或目录链接外的文件', async t => {
  const { document, open, files, root, workspace } = await fixture(t)
  const page = await document('test.html', 'test')
  assert.ok(page.url)
  await assert.rejects(open('../', 'directory'), /不在/)
  await writeFile(join(root, 'secret.json'), 'secret')
  await mkdir(join(root, 'outside'))
  await writeFile(join(root, 'outside', 'secret.json'), 'secret')
  await symlink(join(root, 'outside'), join(workspace, 'link'), 'junction')
  await assert.rejects(open('link', 'directory'), /超出/)
  await writeFile(join(workspace, '.env.json'), 'secret')
  await writeFile(join(workspace, 'private.ts'), 'secret')
  for (const path of ['.env.json', 'private.ts', 'link/secret.json', '%2e%2e%2fsecret.json', '..%5csecret.json', 'c%3a/secret.json']) {
    const result = await files.response(new Request(new URL(path, page.url)))
    assert.ok(result.status >= 400, path)
  }
  const directory = await open('', 'directory')
  assert.equal(directory.kind === 'directory' && directory.entries.find(e => e.name === 'link')?.kind, 'other')
})

it('视图严格属于窗口和运行时，关闭撤销地址，包括打开中被释放的视图', async t => {
  const { document, files, open, workspace } = await fixture(t)
  const page = await document('test.txt', '123')
  assert.ok(page.url)
  await assert.rejects(files.read(2, page.id), /视图已关闭/)
  files.close(2, page.id)
  assert.equal((await files.response(new Request(page.url))).status, 200)
  files.closeRuntime('a')
  assert.equal((await files.response(new Request(page.url))).status, 404)
  const opening = open('', 'directory')
  files.closeOwner(1)
  await assert.rejects(opening, /视图已关闭/)
  const again = await files.open(2, { runtimeId: 'b', kind: 'file', path: join(workspace, 'test.txt') }, workspace, () => {})
  files.closeRuntime('a')
  assert.equal((await files.read(2, again.id)).kind, 'file')
  files.closeOwner(2)
  await assert.rejects(files.read(2, again.id), /视图已关闭/)
})

it('活动目录变化通知合并，关闭后停止监听', async t => {
  const { open, workspace, files } = await fixture(t)
  const changes: string[] = []
  const page = await open('', 'directory', id => changes.push(id))
  await writeFile(join(workspace, 'added.txt'), 'added')
  const deadline = Date.now() + 3000
  while (!changes.length && Date.now() < deadline) await delay(30)
  assert.deepEqual(changes, [page.id])
  const updated = await files.read(1, page.id)
  assert.equal(updated.kind === 'directory' && updated.entries[0]?.name, 'added.txt')
  files.closeOwner(1)
  await writeFile(join(workspace, 'added.txt'), 'changed')
  await delay(300)
  assert.deepEqual(changes, [page.id])
})

it('关闭文件视图立即取消仍在读取的正文流', async t => {
  const { files, document } = await fixture(t)
  const page = await document('stream.txt', 'x'.repeat(MAX_TEXT_PREVIEW_BYTES))
  assert.ok(page.url)
  const response = await files.response(new Request(page.url))
  files.close(1, page.id)
  await assert.rejects(response.arrayBuffer(), { name: 'AbortError' })
})
