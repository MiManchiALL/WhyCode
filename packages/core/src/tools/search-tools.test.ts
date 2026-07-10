import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { ToolContext } from './tool.ts'
import { globTool } from './list-glob/index.ts'
import { grepTool } from './grep/index.ts'

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
    assert.match(content.data, /src\/alpha\.ts:2:needle here/)
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
})
