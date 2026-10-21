import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { deleteFileTool } from './file-lifecycle/index.ts'
import type { ToolContext } from './tool.ts'
import { editFileTool, writeFileTool } from './write-edit/index.ts'
import { localWorkspaceIO } from '../workspace/io.ts'
import { CHECKPOINT_FILE_PREVIEW_MAX_BYTES } from '../checkpoints/types.ts'

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

describe('统一精确编辑', () => {
  it('先验证全部替换，再原子修改一个或多个文件', async () => {
    const ctx = await context()
    await writeFile(join(ctx.projectDir, 'a.ts'), 'old one\nold two\n')
    await writeFile(join(ctx.projectDir, 'b.ts'), 'old b\n')

    const result = await editFileTool.execute(
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
    assert.deepEqual(result.fileChanges, [
      { path: 'a.ts', added: 2, removed: 2 },
      { path: 'b.ts', added: 1, removed: 1 },
    ])
    assert.equal(await readFile(join(ctx.projectDir, 'a.ts'), 'utf8'), 'new one\nnew two\n')
    assert.equal(await readFile(join(ctx.projectDir, 'b.ts'), 'utf8'), 'new b\n')
    const scope = await editFileTool.checkpointScope!(
      { edits: [{ path: 'a.ts', oldText: 'new', newText: 'old' }] },
      ctx,
    )
    assert.deepEqual(scope, { kind: 'exact-files', paths: [resolve(ctx.projectDir, 'a.ts')] })
  })

  it('任一替换无效时不写入任何文件', async () => {
    const ctx = await context()
    await writeFile(join(ctx.projectDir, 'a.ts'), 'before a\n')
    await writeFile(join(ctx.projectDir, 'b.ts'), 'before b\n')

    const result = await editFileTool.execute(
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

  it('每处替换都针对原始文件，并拒绝重叠或顺序依赖', async () => {
    const ctx = await context()
    await writeFile(join(ctx.projectDir, 'original.txt'), 'alpha beta gamma\n')

    const sequential = await editFileTool.execute(
      {
        edits: [
          { path: 'original.txt', oldText: 'alpha', newText: 'delta' },
          { path: 'original.txt', oldText: 'delta', newText: 'epsilon' },
        ],
      },
      ctx,
    )
    assert.equal(sequential.isError, true)
    assert.equal(await readFile(join(ctx.projectDir, 'original.txt'), 'utf8'), 'alpha beta gamma\n')

    const overlapping = await editFileTool.execute(
      {
        edits: [
          { path: 'original.txt', oldText: 'alpha beta', newText: 'delta' },
          { path: 'original.txt', oldText: 'beta gamma', newText: 'epsilon' },
        ],
      },
      ctx,
    )
    assert.equal(overlapping.isError, true)
    assert.match(overlapping.data, /重叠或嵌套/)
    assert.equal(await readFile(join(ctx.projectDir, 'original.txt'), 'utf8'), 'alpha beta gamma\n')
  })

  it('默认要求唯一匹配，显式 replaceAll 时替换原始文件中的全部匹配', async () => {
    const ctx = await context()
    await writeFile(join(ctx.projectDir, 'rename.ts'), 'old + old + old\n')

    const ambiguous = await editFileTool.execute(
      { edits: [{ path: 'rename.ts', oldText: 'old', newText: 'next' }] },
      ctx,
    )
    assert.equal(ambiguous.isError, true)
    assert.equal(await readFile(join(ctx.projectDir, 'rename.ts'), 'utf8'), 'old + old + old\n')

    const replaced = await editFileTool.execute(
      {
        edits: [
          { path: 'rename.ts', oldText: 'old', newText: 'next', replaceAll: true },
        ],
      },
      ctx,
    )
    assert.equal(replaced.isError, false)
    assert.equal(await readFile(join(ctx.projectDir, 'rename.ts'), 'utf8'), 'next + next + next\n')
  })

  it('只接受有界的 edits 数组输入', () => {
    assert.equal(editFileTool.inputSchema.safeParse({ edits: [] }).success, false)
    assert.equal(
      editFileTool.inputSchema.safeParse({
        edits: Array.from({ length: 51 }, (_, index) => ({
          path: `${index}.txt`,
          oldText: 'old',
          newText: 'new',
        })),
      }).success,
      false,
    )
    assert.equal(
      editFileTool.inputSchema.safeParse({
        edits: [{ path: 'a.txt', oldText: 'same', newText: 'same' }],
      }).success,
      false,
    )
  })

  it('整文件写入按旧内容精确统计新增与删除行', async () => {
    const ctx = await context()
    await writeFile(join(ctx.projectDir, 'whole.txt'), 'keep\nbefore\n')

    const result = await writeFileTool.execute(
      { path: 'whole.txt', content: 'keep\nafter\nextra\n' },
      ctx,
    )

    assert.equal(result.isError, false)
    assert.deepEqual(result.fileChanges, [
      { path: 'whole.txt', added: 2, removed: 1 },
    ])
  })
})

describe('文件生命周期工具', () => {
  it('删除审批只读取有界文本，二进制和大文件不生成文本差异或行数', async () => {
    const ctx = await context()
    ctx.workspaceIO = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs,
      readFile: async () => assert.fail('生命周期工具不能整批读取完整文件'),
    } }
    await writeFile(join(ctx.projectDir, 'small.txt'), 'one\ntwo\n')
    await writeFile(join(ctx.projectDir, 'binary.tmp'), Buffer.from([0, 255, 10]))
    await writeFile(join(ctx.projectDir, 'invalid-utf8.tmp'), Buffer.from([255, 255, 10]))
    await writeFile(join(ctx.projectDir, 'large.tmp'), Buffer.alloc(CHECKPOINT_FILE_PREVIEW_MAX_BYTES + 1, 97))
    const input = { paths: ['small.txt', 'binary.tmp', 'invalid-utf8.tmp', 'large.tmp'] }
    const diff = await deleteFileTool.renderDiff!(input, ctx)
    assert.match(diff!, /small.txt/)
    assert.doesNotMatch(diff!, /\.tmp/)
    const result = await deleteFileTool.execute(input, ctx)
    assert.equal(result.isError, false)
    assert.deepEqual(result.fileChanges, [{ path: 'small.txt', added: 0, removed: 2 }])
    for (const path of input.paths) await assert.rejects(readFile(join(ctx.projectDir, path)), { code: 'ENOENT' })
  })

  it('任一预检读取失败时保留所有目标，删除中途失败时只报告已删除文件的统计', async () => {
    const ctx = await context()
    for (const name of ['first.txt', 'second.txt']) await writeFile(join(ctx.projectDir, name), name)
    ctx.workspaceIO = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs,
      open: async (path, flags) => {
        if (path.endsWith('second.txt')) throw new Error('读取失败')
        return localWorkspaceIO.fs.open(path, flags)
      },
    } }
    const input = { paths: ['first.txt', 'second.txt'] }
    assert.match((await deleteFileTool.execute(input, ctx)).data, /删除未执行.*读取失败/)
    assert.equal(await readFile(join(ctx.projectDir, 'first.txt'), 'utf8'), 'first.txt')
    ctx.workspaceIO = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs,
      unlink: async path => {
        if (path.endsWith('second.txt')) throw new Error('删除失败')
        await localWorkspaceIO.fs.unlink(path)
      },
    } }
    const result = await deleteFileTool.execute(input, ctx)
    assert.equal(result.isError, true)
    assert.match(result.data, /已删除 1\/2/)
    assert.deepEqual(result.fileChanges, [{ path: 'first.txt', added: 0, removed: 1 }])
    assert.equal(await readFile(join(ctx.projectDir, 'second.txt'), 'utf8'), 'second.txt')
  })

  it('一次删除多个文件，并用一个检查点覆盖全部目标', async () => {
    const ctx = await context()
    await writeFile(join(ctx.projectDir, 'delete-a.txt'), 'content a')
    await writeFile(join(ctx.projectDir, 'delete-b.txt'), 'content b')

    const input = { paths: ['delete-a.txt', 'delete-b.txt'] }
    const scope = await deleteFileTool.checkpointScope!(input, ctx)
    assert.deepEqual(scope, {
      kind: 'exact-files',
      paths: [
        resolve(ctx.projectDir, 'delete-a.txt'),
        resolve(ctx.projectDir, 'delete-b.txt'),
      ],
    })

    const deleted = await deleteFileTool.execute(input, ctx)
    assert.equal(deleted.isError, false)
    assert.equal(deleted.data, '已删除 2 个文件')
    assert.deepEqual(deleted.fileChanges, [
      { path: 'delete-a.txt', added: 0, removed: 1 },
      { path: 'delete-b.txt', added: 0, removed: 1 },
    ])
    await assert.rejects(readFile(join(ctx.projectDir, 'delete-a.txt')))
    await assert.rejects(readFile(join(ctx.projectDir, 'delete-b.txt')))
  })

  it('删除前验证全部目标并拒绝目录', async () => {
    const ctx = await context()
    await writeFile(join(ctx.projectDir, 'keep-file.txt'), 'content')
    await mkdir(join(ctx.projectDir, 'keep-dir'))

    const refused = await deleteFileTool.execute(
      { paths: ['keep-file.txt', 'keep-dir'] },
      ctx,
    )

    assert.equal(refused.isError, true)
    assert.equal(await readFile(join(ctx.projectDir, 'keep-file.txt'), 'utf8'), 'content')
  })

  it('删除路径去重且输入数量有界', async () => {
    const ctx = await context()
    await writeFile(join(ctx.projectDir, 'once.txt'), 'content')

    const deleted = await deleteFileTool.execute(
      { paths: ['once.txt', './once.txt'] },
      ctx,
    )

    assert.equal(deleted.isError, false)
    assert.equal(deleted.data, '已删除 once.txt')
    assert.equal(deleteFileTool.inputSchema.safeParse({ paths: [] }).success, false)
    assert.equal(
      deleteFileTool.inputSchema.safeParse({
        paths: Array.from({ length: 51 }, (_, index) => `${index}.txt`),
      }).success,
      false,
    )
  })
})
