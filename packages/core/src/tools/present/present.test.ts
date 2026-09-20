import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { presentationSchema, readPresentationResult } from '../../presentation.ts'
import { validateToolInput } from '../tool.ts'
import { presentTool } from './index.ts'

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const projectDir = await mkdtemp(join(tmpdir(), 'whycode-present-'))
  t.after(() => rm(projectDir, { recursive: true, force: true }))
  return { projectDir, additionalDirs: [], abortSignal: new AbortController().signal }
}

describe('Present 成品文件声明', () => {
  it('接受命令等方式生成的成品，解析相对路径、去重并保持当前文件不变', async t => {
    const ctx = await fixture(t)
    await writeFile(join(ctx.projectDir, 'index.html'), '<h1>ready</h1>')
    const result = await presentTool.execute({ files: [
      { path: './index.html', description: '旧说明' },
      { path: join(ctx.projectDir, 'index.html'), description: '可交互网页' },
    ] }, ctx)
    assert.equal(result.isError, false)
    assert.deepEqual(readPresentationResult(result.data), {
      files: [{ path: join(ctx.projectDir, 'index.html'), description: '可交互网页' }],
    })
    assert.equal(await readFile(join(ctx.projectDir, 'index.html'), 'utf8'), '<h1>ready</h1>')
  })

  it('拒绝缺失文件、目录与目录链接，不产生部分交付', async t => {
    const ctx = await fixture(t)
    await mkdir(join(ctx.projectDir, 'folder'))
    await symlink(join(ctx.projectDir, 'folder'), join(ctx.projectDir, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    for (const path of ['missing.html', 'folder', 'link']) {
      await assert.rejects(presentTool.execute({ files: [{ path }] }, ctx))
    }
  })

  it('遵守现有路径授权与取消边界', async t => {
    const ctx = await fixture(t)
    const other = await fixture(t)
    const path = join(other.projectDir, 'report.pdf')
    await writeFile(path, 'pdf')
    await assert.rejects(presentTool.execute({ files: [{ path }] }, ctx), /允许范围/)
    assert.equal((await presentTool.execute({ files: [{ path }] }, { ...ctx, additionalDirs: [other.projectDir] })).isError, false)
    await assert.rejects(presentTool.execute({ files: [] }, { ...ctx, abortSignal: AbortSignal.abort() }), /abort/i)
  })

  it('空声明可以清空本次回答的成品', async t => {
    const ctx = await fixture(t)
    assert.deepEqual(readPresentationResult((await presentTool.execute({ files: [] }, ctx)).data), { files: [] })
  })

  it('只接受文件协议，校验数量、额外字段及可见结果大小', async () => {
    assert.equal((await validateToolInput(presentTool, { files: [], sources: [] })).success, false)
    assert.equal(presentationSchema.safeParse({ files: Array(9).fill({ path: 'a.html' }) }).success, false)
    assert.equal(presentationSchema.safeParse({ files: [], ignored: true }).success, false)
    for (const path of ['notes.txt', 'app.ts', 'data.json', 'report.docx', 'slides.pptx', 'archive.zip']) {
      assert.equal((await validateToolInput(presentTool, { files: [{ path }] })).success, false)
    }
    for (const path of ['index.HTML', 'report.md', 'chart.svg', 'photo.png', 'book.pdf']) {
      assert.equal((await validateToolInput(presentTool, { files: [{ path }] })).success, true)
    }
    assert.equal(readPresentationResult('{"files":['), null)
    assert.equal(presentationSchema.safeParse({ files: Array(8).fill({ path: '"'.repeat(2043) + '.html', description: '说明'.repeat(80) }) }).success, false)
  })
})
