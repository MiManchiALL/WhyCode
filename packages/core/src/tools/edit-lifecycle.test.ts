import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { ToolContext } from './tool.ts'
import { editFileTool, writeFileTool } from './write-edit/index.ts'
import { readFileTool } from './read-file/index.ts'

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
  it('ReadFile 返回的跨行原文可直接编辑，保留 BOM、混合换行和无换行末行', async () => {
    const ctx = await context()
    const path = 'mixed.txt'
    const absolute = join(ctx.projectDir, path)
    await writeFile(absolute, '\uFEFF甲\r\n  old\r\nkeep\nold\rfinal')
    const read = await readFileTool.execute({ path, limit: 2 }, ctx)
    const oldText = read.data.split('\n').slice(0, 2).map(line => line.slice(line.indexOf('\t') + 1)).join('\n')
    const result = await editFileTool.execute({ edits: [
      { path, oldText, newText: '乙\n  new' },
      { path, oldText: 'old\nfinal', newText: 'x\ny\nz' },
    ] }, ctx)
    assert.deepEqual(await readFile(absolute), Buffer.from('\uFEFF乙\r\n  new\r\nkeep\nx\ry\rz'))
    assert.equal(result.isError, false)
  })

  it('GBK 和含 NUL 文件阻止整批写入，原始字节可逐字节核对', async () => {
    const ctx = await context()
    const good = join(ctx.projectDir, 'one.txt')
    const other = join(ctx.projectDir, 'two.txt')
    await writeFile(good, 'old\n')
    for (const prefix of [Buffer.from([0xd6, 0xd0]), Buffer.from([0])]) {
      const original = Buffer.concat([prefix, Buffer.from(' old')])
      await writeFile(other, original)
      const result = await editFileTool.execute({ edits: ['one.txt', 'two.txt'].map(path => ({ path, oldText: 'old', newText: 'new' })) }, ctx)
      assert.equal(result.isError, true)
      assert.match(result.data, /two\.txt.*UTF-8/)
      assert.equal(await readFile(good, 'utf8'), 'old\n')
      assert.deepEqual(await readFile(other), original)
    }
  })

  it('批量替换按原坐标拼接，替换文本中的美元符号原样保留', async () => {
    const ctx = await context()
    const path = 'many.txt'
    await writeFile(join(ctx.projectDir, path), '  old\r\n'.repeat(8_000))
    const result = await editFileTool.execute({ edits: [{ path, oldText: 'old', newText: '$&\n新', replaceAll: true }] }, ctx)
    assert.equal(result.data, '已编辑 many.txt')
    assert.equal(await readFile(join(ctx.projectDir, path), 'utf8'), '  $&\r\n新\r\n'.repeat(8_000))
  })

  it('写入和编辑审批分开显示相距很远的修改，预览过大时明确省略', async () => {
    const ctx = await context()
    const path = 'preview.txt'
    const before = Array.from({ length: 1_000 }, (_, n) => `line ${n + 1}\n`).join('')
    const edits = [10, 990].map(n => ({ path, oldText: `line ${n}\n`, newText: `edit ${n}  \n` }))
    await writeFile(join(ctx.projectDir, path), before)
    const content = edits.reduce((text, edit) => text.replace(edit.oldText, edit.newText), before)
    const patch = await editFileTool.renderDiff!({ edits }, ctx)
    assert.equal(await writeFileTool.renderDiff!({ path, content }, ctx), patch)
    assert.equal(patch!.match(/^@@/gm)?.length, 2)
    assert.match(patch!, /\+edit 990  \n/)
    assert.doesNotMatch(patch!, /line 500\b/)
    assert.ok(patch!.split('\n').length < 25)
    const large = await writeFileTool.renderDiff!({ path, content: 'x'.repeat(512 * 1024 + 1) }, ctx)
    assert.match(large!, /省略/)
  })

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
