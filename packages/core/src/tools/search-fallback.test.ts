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
