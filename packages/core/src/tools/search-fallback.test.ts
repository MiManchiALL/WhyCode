import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { globTool } from './list-glob/index.ts'
import { grepTool } from './grep/index.ts'
import type { ToolContext } from './tool.ts'

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
