import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { ToolContext } from '../tool.ts'
import { readFileTool } from './index.ts'
import { Readable } from 'node:stream'
import { boundedLines } from './lines.ts'

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
  it('跨数据块的 CRLF 与多兆单行不累积完整内容', async () => {
    const stream = Readable.from(['one\r', '\ntwo\rthree\n', ...Array.from({ length: 32 }, () => 'x'.repeat(64 * 1024)), '\nlast'])
    const lines: string[] = []
    for await (const line of boundedLines(stream, 2_000)) lines.push(line)
    assert.deepEqual(lines, ['one', 'two', 'three', 'x'.repeat(2_001), 'last'])
  })
  it('按 offset/limit 返回行号并提示继续位置', async () => {
    const { ctx } = await fixture('one\ntwo\nthree\nfour\n')
    const result = await readFileTool.execute({ path: 'fixture.txt', offset: 2, limit: 2 }, ctx)
    assert.equal(result.isError, false)
    assert.match(result.data, /2\s+two/)
    assert.match(result.data, /3\s+three/)
    assert.match(result.data, /从第 4 行继续读取/)
    assert.doesNotMatch(result.data, /four/)
  })

  it('完整返回长行并拒绝含 NUL 的二进制文件', async () => {
    const long = await fixture('x'.repeat(2_100))
    const longResult = await readFileTool.execute({ path: 'fixture.txt' }, long.ctx)
    assert.equal(longResult.isError, false)
    assert.equal(longResult.data, `    1\t${'x'.repeat(2_100)}`)

    const binary = await fixture(Buffer.from([0x61, 0, 0x62]))
    const binaryResult = await readFileTool.execute({ path: 'fixture.txt' }, binary.ctx)
    assert.equal(binaryResult.isError, true)
    assert.match(binaryResult.data, /二进制文件/)
  })

  it('长行与跨数据块 Unicode 字符完整保留', async () => {
    const content = `${'x'.repeat(65_535)}😀中文tail`
    const { ctx } = await fixture(content)
    const result = await readFileTool.execute({ path: 'fixture.txt' }, ctx)

    assert.equal(result.isError, false)
    assert.equal(result.data, `    1\t${content}`)
  })

  it('省略 offset/limit 读取超过 1000 行的完整文件', async () => {
    const { ctx } = await fixture(Array.from({ length: 2_100 }, (_, i) => `row ${i + 1}`).join('\n'))
    const result = await readFileTool.execute({ path: 'fixture.txt' }, ctx)
    assert.equal(result.isError, false)
    assert.equal(result.data.split('\n').length, 2_100)
    assert.ok(result.data.endsWith('2100\trow 2100'))
  })

  it('SVG 源码仍作为文本返回', async () => {
    const content = '<svg xmlns="http://www.w3.org/2000/svg"><text>源码</text></svg>'
    const { ctx } = await fixture('')
    await writeFile(join(ctx.projectDir, 'diagram.svg'), content)
    const result = await readFileTool.execute({ path: 'diagram.svg' }, ctx)
    assert.equal(result.isError, false)
    assert.equal(result.data, `    1\t${content}`)
  })

  it('整文件超限明确拒绝，仍可流式跳过数兆长行读取所需范围', async () => {
    const { ctx } = await fixture(`${'x'.repeat(4 * 1024 * 1024)}\n所需内容\n后续\n`)
    const whole = await readFileTool.execute({ path: 'fixture.txt' }, ctx)
    assert.equal(whole.isError, true)
    assert.match(whole.data, /256 KiB/)
    const range = await readFileTool.execute({ path: 'fixture.txt', offset: 2, limit: 1 }, ctx)
    assert.equal(range.isError, false)
    assert.match(range.data, /2\t所需内容/)
    assert.match(range.data, /从第 3 行/)
    const longLine = await readFileTool.execute({ path: 'fixture.txt', limit: 1 }, ctx)
    assert.equal(longLine.isError, true)
    assert.doesNotMatch(longLine.data, /xxx/)
  })

  it('字节未超限但 token 估算超限时，不返回残缺正文', async () => {
    const { ctx } = await fixture('中'.repeat(50_000))
    const result = await readFileTool.execute({ path: 'fixture.txt' }, ctx)
    assert.equal(result.isError, true)
    assert.match(result.data, /25,000 token/)
    assert.doesNotMatch(result.data, /中中/)
  })

  it('空文件、超出末行及取消均有确定结果', async () => {
    const empty = await fixture('')
    assert.equal((await readFileTool.execute({ path: 'fixture.txt' }, empty.ctx)).data, '（空文件）')
    const { ctx } = await fixture('first\nsecond')
    assert.match((await readFileTool.execute({ path: 'fixture.txt', offset: 3 }, ctx)).data, /文件共 2 行/)
    await assert.rejects(readFileTool.execute({ path: 'fixture.txt' }, { ...ctx, abortSignal: AbortSignal.abort() }), /abort/i)
  })

  it('四参数契约拒绝错用分页、无效附件及旧参数', () => {
    for (const pages of ['0', '2-1', '1-21', '1,3', '1-', '9007199254740992']) {
      assert.equal(readFileTool.inputSchema.safeParse({ path: 'a.pdf', pages }).success, false, pages)
    }
    for (const input of [
      { path: 'a.pdf', offset: 1 }, { path: 'a.png', limit: 1 }, { path: 'a.txt', pages: '1' },
      { path: 'attachment://invalid' }, { path: 'a.pdf', pageCount: 1 }, { path: 'a.png', detail: 'high' },
    ]) {
      assert.equal(readFileTool.inputSchema.safeParse(input).success, false, JSON.stringify(input))
    }
    assert.equal(readFileTool.inputSchema.safeParse({ path: 'a.pdf', pages: '3' }).success, true)
    assert.equal(readFileTool.inputSchema.safeParse({ path: 'a.pdf', pages: '21-40' }).success, true)
  })
})
