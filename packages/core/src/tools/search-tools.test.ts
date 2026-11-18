import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { ToolContext } from './tool.ts'
import { globTool, listDirTool } from './list-glob/index.ts'
import { grepTool } from './grep/index.ts'
import { localWorkspaceIO } from '../workspace/io.ts'
import { IGNORED_DIRS } from './fs-utils.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ root: string; ctx: ToolContext }> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-search-'))
  roots.push(root)
  await mkdir(join(root, 'src', 'nested'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'hidden'), { recursive: true })
  await writeFile(join(root, 'src', 'alpha.ts'), 'export const Alpha = 1\nneedle here\ncontext line\n')
  await writeFile(join(root, 'src', 'nested', 'beta.tsx'), 'const beta = "Needle"\n')
  await writeFile(join(root, 'src', 'nested', 'plain.txt'), 'needle in text\n')
  await writeFile(join(root, 'node_modules', 'hidden', 'ignored.ts'), 'needle ignored\n')
  return {
    root,
    ctx: {
      projectDir: root,
      additionalDirs: [],
      abortSignal: new AbortController().signal,
    },
  }
}

describe('高性能搜索工具', () => {
  for (const fallback of [false, true]) {
    it(`${fallback ? '回退' : '原生'}搜索中 include 与各级 ignore 取交集，明确指定文件仍可读`, async () => {
      const { ctx, root } = await fixture()
      if (fallback) ctx.workspaceIO = { ...localWorkspaceIO, identity: 'fallback-fixture' }
      await writeFile(join(root, '.gitignore'), 'git.ts\n')
      await writeFile(join(root, '.ignore'), '*.drop.ts\nkeep.ts\n')
      await writeFile(join(root, '.rgignore'), '!keep.ts\n')
      await writeFile(join(root, 'src', 'nested', '.ignore'), '!exception.drop.ts\n')
      for (const name of ['git.ts', 'a.drop.ts', 'exception.drop.ts', 'keep.ts', '.hidden.ts', 'miss.txt']) {
        await writeFile(join(root, 'src', 'nested', name), 'marker\n')
      }
      const paths = ['.hidden.ts', 'exception.drop.ts', 'keep.ts'].map(n => 'src/nested/' + n)
      for (const [path, include] of [['.', 'src/**/*.ts'], ['src', '*.ts']] as const) {
        const result = await grepTool.execute({ path, include, pattern: 'marker', outputMode: 'files_with_matches' }, ctx)
        assert.deepEqual(result.data.split('\n'), paths)
      }
      const explicit = await grepTool.execute({ path: 'src/nested/git.ts', pattern: 'marker' }, ctx)
      assert.equal(explicit.data, 'src/nested/git.ts:1:marker')
      assert.match((await globTool.execute({ pattern: 'git.ts' }, ctx)).data, /src\/nested\/git\.ts/)
      assert.equal((await globTool.execute({ path: 'src', pattern: './*.ts' }, ctx)).data, 'src/alpha.ts')
      assert.equal((await grepTool.execute({ path: 'src', pattern: 'marker', include: './*.ts' }, ctx)).data, '（无匹配）')
    })

    it(`${fallback ? '回退' : '原生'}搜索的深分页按实际显示行数推进，UTF-8 回包有界`, async () => {
      const { ctx, root } = await fixture()
      if (fallback) ctx.workspaceIO = { ...localWorkspaceIO, identity: 'fallback-fixture' }
      const path = 'deep.log'
      const line = '中'.repeat(100)
      await writeFile(join(root, path), (line + '\n').repeat(5_000))
      let offset = 4_700
      while (offset < 5_000) {
        const result = await grepTool.execute({ path, pattern: '中', offset, limit: 1_000 }, ctx)
        assert.equal(result.isError, false)
        assert.ok(Buffer.byteLength(result.data) <= 32 * 1024)
        const rows = result.data.split('\n')
        assert.equal(rows.shift(), path)
        const next = rows.at(-1)?.match(/offset=(\d+)/)
        if (next) rows.pop()
        assert.ok(rows.length > 0)
        for (const row of rows) assert.equal(row, `${++offset}:${line}`)
        if (next) assert.equal(Number(next[1]), offset)
        else assert.equal(offset, 5_000)
      }
      assert.equal((await grepTool.execute({ path, pattern: '中', offset }, ctx)).data, '（已到结果末尾）')
    })

    it(`${fallback ? '回退' : '原生'}搜索在每层跳过依赖、缓存和构建目录`, async () => {
      const { root, ctx } = await fixture()
      for (const prefix of ['', 'src/nested']) {
        for (const name of IGNORED_DIRS) {
          const directory = join(root, prefix, name, 'deeper')
          await mkdir(directory, { recursive: true })
          await writeFile(join(directory, 'target.txt'), 'needle excluded\n')
        }
      }
      await mkdir(join(root, 'src', 'build-tools'))
      await writeFile(join(root, 'target.txt'), 'needle root\n')
      await writeFile(join(root, 'src', 'build-tools', 'target.txt'), 'needle source\n')
      if (fallback) ctx.workspaceIO = { ...localWorkspaceIO, identity: 'fallback-fixture' }

      const glob = await globTool.execute({ pattern: '**/target.txt' }, ctx)
      assert.equal(glob.isError, false)
      assert.deepEqual(glob.data.split('\n'), ['src/build-tools/target.txt', 'target.txt'])
      const grep = await grepTool.execute({ pattern: 'needle', include: '**/target.txt' }, ctx)
      assert.equal(grep.isError, false)
      assert.deepEqual(grep.data.split('\n'), ['src/build-tools/target.txt:1:needle source', 'target.txt:1:needle root'])
    })
  }

  it('Glob 支持搜索根目录、brace 模式、分页并跳过依赖目录', async () => {
    const { ctx } = await fixture()
    const first = await globTool.execute(
      { pattern: '**/*.{ts,tsx}', path: 'src', limit: 1 },
      ctx,
    )
    assert.match(first.data, /src\//)
    assert.match(first.data, /offset=1/)
    assert.doesNotMatch(first.data, /node_modules/)

    const second = await globTool.execute(
      { pattern: '**/*.{ts,tsx}', path: 'src', limit: 2, offset: 1 },
      ctx,
    )
    assert.match(second.data, /\.tsx?/) 
  })

  it('Grep 支持内容、上下文、大小写、文件列表与计数模式', async () => {
    const { ctx } = await fixture()
    const content = await grepTool.execute(
      {
        pattern: 'needle',
        path: 'src',
        include: '*.{ts,tsx}',
        caseSensitive: false,
        context: 1,
        outputMode: 'content',
        limit: 20,
      },
      ctx,
    )
    assert.match(content.data, /src\/alpha\.ts\n1-export const Alpha = 1\n2:needle here\n3-context line/)
    assert.match(content.data, /src\/nested\/beta\.tsx:1:const beta/)
    assert.match(content.data, /context line/)
    assert.doesNotMatch(content.data, /plain\.txt/)

    const files = await grepTool.execute(
      { pattern: 'needle', literal: true, outputMode: 'files_with_matches' },
      ctx,
    )
    assert.match(files.data, /src\/alpha\.ts/)
    assert.doesNotMatch(files.data, /node_modules/)

    const counts = await grepTool.execute(
      { pattern: 'needle', literal: true, outputMode: 'count' },
      ctx,
    )
    assert.match(counts.data, /src\/alpha\.ts:1/)
  })
  it('ListDir 区分空目录和非空目录的页尾', async () => {
    const { ctx, root } = await fixture()
    await mkdir(join(root, 'empty'))
    assert.equal((await listDirTool.execute({ path: 'empty' }, ctx)).data, '（空目录）')
    assert.equal((await listDirTool.execute({ path: 'src', offset: 2 }, ctx)).data, '（已到目录末尾，共 2 项）')
  })
})
