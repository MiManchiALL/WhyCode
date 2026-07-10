import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { ToolContext } from '../tool.ts'
import { readFileTool } from './index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(content: string | Buffer): Promise<{ path: string; ctx: ToolContext }> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-read-'))
  roots.push(root)
  const path = join(root, 'fixture.txt')
  await writeFile(path, content)
  return {
    path,
    ctx: {
      projectDir: root,
      additionalDirs: [],
      abortSignal: new AbortController().signal,
    },
  }
}

describe('ReadFile 流式读取', () => {
  it('按 offset/limit 返回行号并提示继续位置', async () => {
    const { ctx } = await fixture('one\ntwo\nthree\nfour\n')
    const result = await readFileTool.execute({ path: 'fixture.txt', offset: 2, limit: 2 }, ctx)
    assert.equal(result.isError, false)
    assert.match(result.data, /2\s+two/)
    assert.match(result.data, /3\s+three/)
    assert.match(result.data, /offset=4/)
    assert.doesNotMatch(result.data, /four/)
  })

  it('截断超长单行并拒绝含 NUL 的二进制文件', async () => {
    const long = await fixture('x'.repeat(2_100))
    const longResult = await readFileTool.execute({ path: 'fixture.txt' }, long.ctx)
    assert.match(longResult.data, /本行超过 2000 字符/)

    const binary = await fixture(Buffer.from([0x61, 0, 0x62]))
    const binaryResult = await readFileTool.execute({ path: 'fixture.txt' }, binary.ctx)
    assert.equal(binaryResult.isError, true)
    assert.match(binaryResult.data, /二进制文件/)
  })
})
