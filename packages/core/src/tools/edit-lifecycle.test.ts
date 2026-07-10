import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { batchEditTool } from './batch-edit/index.ts'
import { deleteFileTool, moveFileTool } from './file-lifecycle/index.ts'
import type { ToolContext } from './tool.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function context(): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-edit-'))
  roots.push(root)
  return {
    projectDir: root,
    additionalDirs: [],
    abortSignal: new AbortController().signal,
  }
}

describe('批量编辑', () => {
  it('先验证全部替换，再一次修改多个文件', async () => {
    const ctx = await context()
    await writeFile(join(ctx.projectDir, 'a.ts'), 'old one\nold two\n')
    await writeFile(join(ctx.projectDir, 'b.ts'), 'old b\n')

    const result = await batchEditTool.execute(
      {
        edits: [
          { path: 'a.ts', oldText: 'old one', newText: 'new one' },
          { path: 'a.ts', oldText: 'old two', newText: 'new two' },
          { path: 'b.ts', oldText: 'old b', newText: 'new b' },
        ],
      },
      ctx,
    )

    assert.equal(result.isError, false)
    assert.equal(await readFile(join(ctx.projectDir, 'a.ts'), 'utf8'), 'new one\nnew two\n')
    assert.equal(await readFile(join(ctx.projectDir, 'b.ts'), 'utf8'), 'new b\n')
    const scope = await batchEditTool.checkpointScope!(
      { edits: [{ path: 'a.ts', oldText: 'new', newText: 'old' }] },
      ctx,
    )
    assert.deepEqual(scope, { kind: 'exact-files', paths: [resolve(ctx.projectDir, 'a.ts')] })
  })

  it('任一替换无效时不写入任何文件', async () => {
    const ctx = await context()
    await writeFile(join(ctx.projectDir, 'a.ts'), 'before a\n')
    await writeFile(join(ctx.projectDir, 'b.ts'), 'before b\n')

    const result = await batchEditTool.execute(
      {
        edits: [
          { path: 'a.ts', oldText: 'before', newText: 'after' },
          { path: 'b.ts', oldText: 'missing', newText: 'after' },
        ],
      },
      ctx,
    )

    assert.equal(result.isError, true)
    assert.equal(await readFile(join(ctx.projectDir, 'a.ts'), 'utf8'), 'before a\n')
    assert.equal(await readFile(join(ctx.projectDir, 'b.ts'), 'utf8'), 'before b\n')
  })
})

describe('文件生命周期工具', () => {
  it('移动文件时创建父目录且拒绝覆盖目标', async () => {
    const ctx = await context()
    await writeFile(join(ctx.projectDir, 'source.txt'), 'source')
    const moved = await moveFileTool.execute(
      { source: 'source.txt', destination: 'nested/destination.txt' },
      ctx,
    )
    assert.equal(moved.isError, false)
    assert.equal(await readFile(join(ctx.projectDir, 'nested', 'destination.txt'), 'utf8'), 'source')

    await writeFile(join(ctx.projectDir, 'other.txt'), 'other')
    const refused = await moveFileTool.execute(
      { source: 'other.txt', destination: 'nested/destination.txt' },
      ctx,
    )
    assert.equal(refused.isError, true)
    assert.equal(await readFile(join(ctx.projectDir, 'other.txt'), 'utf8'), 'other')
  })

  it('删除文件但拒绝目录', async () => {
    const ctx = await context()
    await writeFile(join(ctx.projectDir, 'delete-me.txt'), 'content')
    const deleted = await deleteFileTool.execute({ path: 'delete-me.txt' }, ctx)
    assert.equal(deleted.isError, false)
    await assert.rejects(readFile(join(ctx.projectDir, 'delete-me.txt')))

    await mkdir(join(ctx.projectDir, 'keep-dir'))
    const refused = await deleteFileTool.execute({ path: 'keep-dir' }, ctx)
    assert.equal(refused.isError, true)
  })
})
