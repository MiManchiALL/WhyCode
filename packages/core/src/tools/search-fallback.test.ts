import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { globTool } from './list-glob/index.ts'
import { grepTool } from './grep/index.ts'
import type { ToolContext } from './tool.ts'
import { localWorkspaceIO } from '../workspace/io.ts'
import { SEARCH_TIMEOUT_MS } from './search/deadline.ts'

let root = ''
let originalPath: string | undefined
let ctx: ToolContext

before(async () => {
  originalPath = process.env.PATH
  process.env.PATH = ''
  root = await mkdtemp(join(tmpdir(), 'whycode-search-fallback-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'one.ts'), 'fallback needle\n')
  await writeFile(join(root, 'src', 'two.tsx'), 'another Needle\n')
  ctx = {
    projectDir: root,
    additionalDirs: [],
    abortSignal: new AbortController().signal,
  }
})

after(async () => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  await rm(root, { recursive: true, force: true })
})

describe('搜索无 ripgrep 回退', () => {
  it('明确指定的大文件返回未搜索原因，目录搜索只返回一条不完整说明', async () => {
    const path = 'large.log'
    await writeFile(join(root, path), 'needle\n' + ' '.repeat(2 * 1024 * 1024))
    const single = await grepTool.execute({ path, pattern: 'needle' }, ctx)
    assert.equal(single.isError, true)
    assert.match(single.data, /large\.log.*2 MiB/)
    const partial = await grepTool.execute({ include: '*.log', pattern: 'needle' }, ctx)
    assert.equal(partial.isError, false)
    assert.equal(partial.data, '[搜索不完整：1 个文件超过 2 MiB]')
  })
  it('跨文件批次分页只跳过一次，连续匹配和上下文分别标记', async () => {
    const directory = join(root, 'batch')
    await mkdir(directory)
    for (let n = 0; n < 20; n++) {
      await writeFile(join(directory, `${String(n).padStart(2, '0')}.txt`), 'before\nmatch\nmatch\nafter\n')
    }
    const result = await grepTool.execute({ path: 'batch', pattern: 'match', context: 1, offset: 68, limit: 4 }, ctx)
    assert.equal(result.data, 'batch/17.txt\n1-before\n2:match\n3:match\n4-after\n[用 offset=72 继续]')
  })
  it('basename 模式匹配子目录，include 在读文件之前过滤', async () => {
    await writeFile(join(root, 'src', 'ignored.bin'), Buffer.alloc(100_000, 1))
    const glob = await globTool.execute({ pattern: '*.ts' }, ctx)
    assert.match(glob.data, /src\/one\.ts/)
    const reads: string[] = []
    const io = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs, open: async (path: string) => {
      reads.push(path); return localWorkspaceIO.fs.open(path, 'r')
    } } }
    const result = await grepTool.execute({ pattern: 'needle', include: '*.ts' }, { ...ctx, workspaceIO: io })
    assert.match(result.data, /fallback needle/)
    assert.deepEqual(reads, [join(root, 'src', 'one.ts')])
  })
  it('灾难性回溯的正则仍可由总超时终止，不阻塞主线程', { timeout: 5_000 }, async t => {
    await writeFile(join(root, 'bomb.txt'), 'a'.repeat(30_000) + '!')
    const io = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs, open: async (path: string) => {
      const reader = await localWorkspaceIO.fs.open(path, 'r')
      return { ...reader, stat: () => reader.stat(), read: reader.read.bind(reader), close: async () => {
        await reader.close()
        setImmediate(() => t.mock.timers.tick(SEARCH_TIMEOUT_MS))
      } }
    } } }
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const result = await grepTool.execute({ pattern: '(a+)+$', include: 'bomb.txt' }, { ...ctx, workspaceIO: io })
    assert.equal(result.isError, true)
    assert.match(result.data, /搜索超时/)
  })
  it('回退正则与纯文本语义分离，并显示无效正则错误', async () => {
    await writeFile(join(root, 'literal.txt'), '[a].* needle')
    const result = await grepTool.execute({ pattern: '[a].*', literal: true, include: 'literal.txt' }, ctx)
    assert.match(result.data, /literal.txt:1:\[a\]\.\*/)
    await assert.rejects(grepTool.execute({ pattern: '[', include: 'missing.txt' }, ctx), /regular expression/i)
  })
  it('并发 Node.js 遍历仍支持 glob 与 grep 核心语义', async () => {
    const glob = await globTool.execute({ pattern: '**/*.{ts,tsx}' }, ctx)
    assert.match(glob.data, /src\/one\.ts/)
    assert.match(glob.data, /src\/two\.tsx/)

    const grep = await grepTool.execute(
      {
        pattern: 'needle',
        include: '*.{ts,tsx}',
        caseSensitive: false,
        outputMode: 'content',
      },
      ctx,
    )
    assert.match(grep.data, /src\/one\.ts:1:fallback needle/)
    assert.match(grep.data, /src\/two\.tsx:1:another Needle/)
  })
})
