import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { asSchema } from 'ai'
import { validateToolInput, type ToolContext } from './tool.ts'
import { globTool, listDirTool } from './list-glob/index.ts'
import { grepTool } from './grep/index.ts'
import { localWorkspaceIO } from '../workspace/io.ts'

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
  it('模型可见的搜索参数只要求 pattern，页长由工具决定', async () => {
    const grep = await asSchema(grepTool.inputSchema).jsonSchema
    const glob = await asSchema(globTool.inputSchema).jsonSchema
    assert.deepEqual(Object.keys(grep.properties ?? {}).sort(), ['caseSensitive', 'gitignore', 'include', 'offset', 'outputMode', 'path', 'pattern'])
    assert.deepEqual(Object.keys(glob.properties ?? {}).sort(), ['gitignore', 'offset', 'path', 'pattern'])
    assert.deepEqual(grep.required, ['pattern'])
    assert.deepEqual(glob.required, ['pattern'])
    for (const option of [{ limit: 1 }, { context: 1 }, { literal: true }]) {
      assert.equal((await validateToolInput(grepTool, { pattern: 'x', ...option })).success, false)
    }
    assert.equal((await validateToolInput(globTool, { pattern: '*', limit: 1 })).success, false)
  })

  for (const fallback of [false, true]) {
    it(`${fallback ? '回退' : '原生'} Glob 区分根目录缺失、路径是文件和没有匹配项`, async () => {
      const { ctx } = await fixture()
      if (fallback) ctx.workspaceIO = { ...localWorkspaceIO, identity: 'fallback-fixture' }
      await assert.rejects(globTool.execute({ path: 'missing/subdir', pattern: '*.ts' }, ctx),
        { message: '搜索路径不存在' })
      assert.deepEqual(await globTool.execute({ path: 'src/alpha.ts', pattern: '*.ts' }, ctx),
        { data: '搜索路径应为目录', isError: true })
      assert.deepEqual(await globTool.execute({ path: 'src', pattern: 'missing.ts' }, ctx),
        { data: '（无匹配文件）', isError: false })
    })

    it(`${fallback ? '回退' : '原生'} Glob 跨目录按文件修改时间选页，每页独立折叠目录`, async () => {
      const { root, ctx } = await fixture()
      if (fallback) ctx.workspaceIO = { ...localWorkspaceIO, identity: 'fallback-fixture' }
      const base = 'packages/example/source'
      await mkdir(join(root, base, 'nested'), { recursive: true })
      await mkdir(join(root, base, 'empty.ts'))
      const names = Array.from({ length: 196 }, (_, n) => String(n).padStart(3, '0') + '.ts')
      const newestFirst = ['z.ts', ...names.slice(0, 195), 'nested/f.ts', 'nested/e.ts', 'nested/d.ts', 'nested/c.ts',
        'nested/b.ts', 'nested/a.ts', 'y.ts', '195.ts']
      for (const [n, name] of newestFirst.entries()) {
        const path = join(root, base, name)
        await writeFile(path, '')
        const seconds = 1_700_000_000 - n
        await utimes(path, seconds, seconds)
      }
      const first = await globTool.execute({ path: base, pattern: '*.ts' }, ctx)
      assert.deepEqual(first.data.split('\n'), ['# ' + base + '/', 'z.ts', ...names.slice(0, 195), '## nested/', 'f.ts', 'e.ts', 'd.ts', 'c.ts', '[用 offset=200 继续]'])
      const next = await globTool.execute({ path: base, pattern: '*.ts', offset: 200 }, ctx)
      assert.deepEqual(next.data.split('\n'), ['# ' + base + '/', '## nested/', 'b.ts', 'a.ts', '# ' + base + '/', 'y.ts', '195.ts'])
    })

    it(`${fallback ? '回退' : '原生'} Glob 路径过长时按实际文件数续页，时间相同的文件无重复或遗漏`, async () => {
      const { root, ctx } = await fixture()
      if (fallback) ctx.workspaceIO = { ...localWorkspaceIO, identity: 'fallback-fixture' }
      const names = Array.from({ length: 421 }, (_, n) => String(n).padStart(3, '0') + '-' + '测'.repeat(60) + '.log')
      for (const name of names) {
        const path = join(root, name)
        const seconds = name === names.at(-1) ? 1_700_000_001 : 1_700_000_000
        await writeFile(path, '')
        await utimes(path, seconds, seconds)
      }
      const files: string[] = []
      for (;;) {
        const result = await globTool.execute({ pattern: '*.log', offset: files.length }, ctx)
        assert.equal(result.isError, false)
        assert.ok(Buffer.byteLength(result.data) <= 32 * 1024)
        const rows = result.data.split('\n')
        const next = rows.at(-1)?.match(/^\[用 offset=(\d+) 继续\]$/)
        if (next) rows.pop()
        assert.ok(rows.length > 0 && rows.length < 200)
        files.push(...rows)
        if (!next) break
        assert.equal(Number(next[1]), files.length)
        assert.ok(files.length < names.length)
      }
      assert.equal(files[0], names.at(-1))
      assert.deepEqual(files.sort(), names)
    })

    it(`${fallback ? '回退' : '原生'}目录搜索按 gitignore 开关应用各级规则，明确指定文件仍可读`, async () => {
      const { ctx, root } = await fixture()
      if (fallback) ctx.workspaceIO = { ...localWorkspaceIO, identity: 'fallback-fixture' }
      await writeFile(join(root, '.gitignore'), 'git.ts\n')
      await writeFile(join(root, '.ignore'), '*.drop.ts\nkeep.ts\n')
      await writeFile(join(root, '.rgignore'), '!keep.ts\n')
      await writeFile(join(root, 'src', 'nested', '.ignore'), '!exception.drop.ts\n')
      await mkdir(join(root, '.git', 'info'), { recursive: true })
      await writeFile(join(root, '.git', 'info', 'exclude'), 'excluded.ts\n')
      const names = ['.hidden.ts', 'a.drop.ts', 'exception.drop.ts', 'excluded.ts', 'git.ts', 'keep.ts']
      for (const name of [...names, 'miss.txt']) {
        await writeFile(join(root, 'src', 'nested', name), 'marker\n')
      }
      for (const gitignore of [undefined, false]) {
        const expected = gitignore === false ? names : ['.hidden.ts', 'exception.drop.ts', 'keep.ts']
        const paths = expected.map(name => 'src/nested/' + name)
        for (const [path, include] of [['.', 'src/nested/*.ts'], ['src/nested', '*.ts']] as const) {
          const grep = await grepTool.execute({ path, include, pattern: 'marker', outputMode: 'files_with_matches', gitignore }, ctx)
          assert.deepEqual(grep.data.split('\n'), paths)
          const glob = await globTool.execute({ path, pattern: include, gitignore }, ctx)
          const [directory, ...files] = glob.data.split('\n')
          assert.equal(directory, '# src/nested/')
          assert.deepEqual(files.sort(), expected)
        }
      }
      const explicit = await grepTool.execute({ path: 'src/nested/git.ts', pattern: 'marker' }, ctx)
      assert.equal(explicit.data, 'src/nested/git.ts:1:marker')
      assert.equal((await globTool.execute({ path: 'src', pattern: './*.ts' }, ctx)).data, 'src/alpha.ts')
      assert.equal((await grepTool.execute({ path: 'src', pattern: 'marker', include: './*.ts' }, ctx)).data, '（无匹配）')
    })

    it(`${fallback ? '回退' : '原生'} Grep 按匹配行或文件每页返回 250 条`, async () => {
      const { root, ctx } = await fixture()
      if (fallback) ctx.workspaceIO = { ...localWorkspaceIO, identity: 'fallback-fixture' }
      const names = Array.from({ length: 251 }, (_, n) => String(n).padStart(3, '0') + '.txt')
      for (const name of names) await writeFile(join(root, name), 'hit hit\nother\nhit\n')
      for (const outputMode of ['files_with_matches', 'count'] as const) {
        const query = { pattern: 'hit', outputMode }
        const entries = outputMode === 'count' ? names.map(name => name + ':2') : names
        const first = await grepTool.execute(query, ctx)
        assert.deepEqual(first.data.split('\n'), [...entries.slice(0, 250), '[用 offset=250 继续]'])
        assert.equal((await grepTool.execute({ ...query, offset: 250 }, ctx)).data, entries[250])
      }
      const first = await grepTool.execute({ pattern: 'hit' }, ctx)
      const rows = names.slice(0, 125).flatMap(name => [name, '1:hit hit', '3:hit'])
      assert.deepEqual(first.data.split('\n'), [...rows, '[用 offset=250 继续]'])
      assert.equal((await grepTool.execute({ pattern: 'hit', offset: 500 }, ctx)).data, '250.txt\n1:hit hit\n3:hit')
    })

    it(`${fallback ? '回退' : '原生'}显式目录作为搜索起点，内部文件仍遵循项目规则`, async () => {
      const { root, ctx } = await fixture()
      if (fallback) ctx.workspaceIO = { ...localWorkspaceIO, identity: 'fallback-fixture' }
      const path = 'logs/inner'
      await mkdir(join(root, path), { recursive: true })
      await writeFile(join(root, '.gitignore'), 'logs/\nlogs/**/private.log\n')
      for (const name of ['debug.log', 'private.log']) await writeFile(join(root, path, name), 'trace')
      assert.equal((await globTool.execute({ pattern: '*.log' }, ctx)).data, '（无匹配文件）')
      assert.equal((await globTool.execute({ path, pattern: '*.log' }, ctx)).data, path + '/debug.log')
      assert.equal((await grepTool.execute({ path, pattern: 'trace' }, ctx)).data, path + '/debug.log:1:trace')
      const both = await globTool.execute({ path, pattern: '*.log', gitignore: false }, ctx)
      assert.deepEqual(both.data.split('\n').sort(), [path + '/debug.log', path + '/private.log'])
    })

    it(`${fallback ? '回退' : '原生'}搜索的深分页按实际显示行数推进，UTF-8 回包有界`, async () => {
      const { ctx, root } = await fixture()
      if (fallback) ctx.workspaceIO = { ...localWorkspaceIO, identity: 'fallback-fixture' }
      const path = 'deep.log'
      const line = '中'.repeat(100)
      await writeFile(join(root, path), (line + '\n').repeat(5_000))
      let offset = 4_700
      while (offset < 5_000) {
        const result = await grepTool.execute({ path, pattern: '中', offset }, ctx)
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

    it(`${fallback ? '回退' : '原生'}递归搜索固定跳过 .git 和 node_modules，其余目录按忽略规则筛选`, async () => {
      const { root, ctx } = await fixture()
      if (fallback) ctx.workspaceIO = { ...localWorkspaceIO, identity: 'fallback-fixture' }
      const directories = ['.git', 'node_modules', 'src/nested/.git', 'src/nested/node_modules', 'build', 'dist', 'src/.cache']
      for (const path of directories) {
        const directory = join(root, path)
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, 'target.txt'), 'needle\n')
      }
      await writeFile(join(root, '.gitignore'), 'dist/\n')

      for (const gitignore of [undefined, false]) {
        const paths = gitignore === false
          ? ['build/target.txt', 'dist/target.txt', 'src/.cache/target.txt']
          : ['build/target.txt', 'src/.cache/target.txt']
        const glob = await globTool.execute({ pattern: '**/target.txt', gitignore }, ctx)
        const grep = await grepTool.execute({ pattern: 'needle', include: '**/target.txt', outputMode: 'files_with_matches', gitignore }, ctx)
        assert.deepEqual(glob.data.split('\n').sort(), paths)
        assert.deepEqual(grep.data.split('\n'), paths)
      }
      const include = 'node_modules/**/*.ts'
      assert.equal((await grepTool.execute({ pattern: 'needle', include, gitignore: false }, ctx)).data, '（无匹配）')
      assert.equal((await globTool.execute({ pattern: include, gitignore: false }, ctx)).data, '（无匹配文件）')
      const path = 'node_modules/hidden'
      assert.equal((await globTool.execute({ path, pattern: '*.ts' }, ctx)).data, path + '/ignored.ts')
      assert.equal((await grepTool.execute({ path, pattern: 'needle', include: '*.ts' }, ctx)).data, path + '/ignored.ts:1:needle ignored')
    })
  }

  it('Glob 的 brace 模式支持递归及相对于搜索目录的匹配', async () => {
    const { ctx } = await fixture()
    const recursive = await globTool.execute({ pattern: '**/*.{ts,tsx}', path: 'src' }, ctx)
    assert.deepEqual(recursive.data.split('\n').sort(), ['src/alpha.ts', 'src/nested/beta.tsx'])
    const direct = await globTool.execute({ pattern: 'src/*.{ts,tsx}' }, ctx)
    assert.equal(direct.data, 'src/alpha.ts')
    for (const pattern of ['{alpha.ts,archive:old}', 'alph{a..c}.ts', '[[:alpha:]]*.ts']) {
      assert.equal((await globTool.execute({ pattern, path: 'src' }, ctx)).data, 'src/alpha.ts')
    }
  })

  it('只将指定搜索路径的缺失归为找不到文件，保留权限与可执行文件故障', async () => {
    const { ctx, root } = await fixture()
    const external = await fixture()
    const target = join(external.root, 'missing')
    await assert.rejects(grepTool.execute({ path: target, pattern: 'x' }, { ...ctx, additionalDirs: [external.root] }),
      { message: '搜索路径不存在' })
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    for (const tool of [grepTool, globTool]) {
      await assert.rejects(tool.execute({ pattern: 'x' }, {
        ...ctx, workspaceIO: { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs, stat: async () => { throw denied } } },
      }), error => error === denied)
      await assert.rejects(tool.execute({ pattern: 'x' }, {
        ...ctx, workspaceIO: { ...localWorkspaceIO, ripgrepPath: join(root, 'missing-ripgrep') },
      }), { code: 'ENOENT' })
    }
  })

  it('Grep 可按文件类型和大小写匹配，只返回匹配行', async () => {
    const { ctx } = await fixture()
    const content = await grepTool.execute(
      {
        pattern: 'needle',
        path: 'src',
        include: '*.{ts,tsx}',
        caseSensitive: false,
        outputMode: 'content',
      },
      ctx,
    )
    assert.deepEqual(content.data.split('\n'), ['src/alpha.ts:2:needle here', 'src/nested/beta.tsx:1:const beta = "Needle"'])
  })
  it('ListDir 保留单层目录过滤，并区分空目录和非空目录的页尾', async () => {
    const { ctx, root } = await fixture()
    for (const name of ['empty', '.cache', 'build', 'dist']) await mkdir(join(root, name))
    assert.equal((await listDirTool.execute({ path: '.' }, ctx)).data, 'empty/\nsrc/')
    assert.equal((await listDirTool.execute({ path: 'empty' }, ctx)).data, '（空目录）')
    assert.equal((await listDirTool.execute({ path: 'src', offset: 2 }, ctx)).data, '（已到目录末尾，共 2 项）')
  })
})
