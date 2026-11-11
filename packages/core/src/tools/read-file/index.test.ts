import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, it } from 'node:test'
import { estimateTextTokens } from '../../context/tokens.ts'
import { isWellFormedUnicode } from '../../text.ts'
import { localWorkspaceIO } from '../../workspace/io.ts'
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
  it('跨块的 CRLF、空行和未换行的末行保留原行号', async () => {
    const { ctx } = await fixture(`${'a'.repeat(65_535)}\r\n\rtwo\nlast`)
    const result = await readFileTool.execute({ path: 'fixture.txt', offset: 2 }, ctx)
    assert.equal(result.data, '    2\t\n    3\ttwo\n    4\tlast')
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

  it('多页短行按下一行续读，完整拼回每行内容', async () => {
    const rows = Array.from({ length: 2_000 }, (_, i) => `${i + 1} ${'内容'.repeat(40)}`)
    const { ctx } = await fixture(rows.join('\n'))
    let offset = 1
    let pages = 0
    for (;;) {
      const result = await readFileTool.execute({ path: 'fixture.txt', offset }, ctx)
      assert.equal(result.isError, false)
      assert.ok(estimateTextTokens(result.data) <= 25_000 && Buffer.byteLength(result.data) <= 256 * 1024)
      const lines = result.data.split('\n')
      const next = /offset=(\d+)/u.exec(lines.at(-1)!)
      if (next) lines.pop()
      assert.ok(lines.length > 0)
      for (const line of lines) {
        assert.equal(line, `${String(offset).padStart(5)}\t${rows[offset - 1]}`)
        offset++
      }
      pages++
      if (!next) break
      assert.equal(Number(next[1]), offset)
    }
    assert.ok(pages > 1)
    assert.equal(offset, rows.length + 1)
  })

  it('SVG 源码仍作为文本返回', async () => {
    const content = '<svg xmlns="http://www.w3.org/2000/svg"><text>源码</text></svg>'
    const { ctx } = await fixture('')
    await writeFile(join(ctx.projectDir, 'diagram.svg'), content)
    const result = await readFileTool.execute({ path: 'diagram.svg' }, ctx)
    assert.equal(result.isError, false)
    assert.equal(result.data, `    1\t${content}`)
  })

  it('整读和显式请求 70 行都先交付前 69 个完整行，并能跳过超长行', async () => {
    const rows = Array.from({ length: 69 }, (_, i) => `row-${i + 1}`)
    const { ctx } = await fixture([...rows, 'x'.repeat(4 * 1024 * 1024), '末行'].join('\n'))
    for (const range of [{}, { offset: 1, limit: 70 }]) {
      const result = await readFileTool.execute({ path: 'fixture.txt', ...range }, ctx)
      assert.equal(result.isError, false)
      const lines = result.data.split('\n')
      const notice = lines.pop()!
      assert.match(notice, /offset=70\b/)
      if (range.limit) assert.match(notice, /limit=1\b/)
      assert.deepEqual(lines, rows.map((row, i) => `${String(i + 1).padStart(5)}\t${row}`))
    }
    const tail = await readFileTool.execute({ path: 'fixture.txt', offset: 71 }, ctx)
    assert.equal(tail.data, '   71\t末行')
  })

  it('超长行可在到达换行或 EOF 前返回片段并关闭读取流', async () => {
    const { ctx } = await fixture('test')
    const chunk = 'x'.repeat(64 * 1024)
    const stream = Readable.from((function* () {
      for (let n = 0; n < 12; n++) yield chunk
      throw new Error('读取超过一页仍在等待换行')
    })())
    const workspaceIO = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs, createReadStream: () => stream } }
    const result = await readFileTool.execute({ path: 'fixture.txt' }, { ...ctx, workspaceIO })
    assert.equal(result.isError, false)
    assert.match(result.data, /offset=1, column=\d+/u)
    assert.ok(stream.destroyed)
  })

  for (const [budget, content] of [
    ['token', '中😀'.repeat(32_000)],
    ['字节', '€'.repeat(90_000)],
  ] as const) {
    it(`起始行超过 ${budget} 上限时按提示续读，完整拼回 Unicode 原文`, async () => {
      const { ctx } = await fixture(`first\r\n${content}\r\nlast`)
      let column = 1
      let restored = ''
      for (;;) {
        const result = await readFileTool.execute({ path: 'fixture.txt', offset: 2, column, limit: 1 }, ctx)
        assert.equal(result.isError, false)
        assert.ok(Buffer.byteLength(result.data) <= 256 * 1024)
        assert.ok(estimateTextTokens(result.data) <= 25_000)
        const [row, notice] = result.data.split('\n')
        assert.ok(row && notice)
        const [label, fragment] = row.split('\t')
        assert.equal(label?.trim(), column === 1 ? '2' : `2:${column}`)
        assert.ok(fragment && isWellFormedUnicode(fragment))
        restored += fragment
        const cursor = /offset=2, column=(\d+)/u.exec(notice)
        if (!cursor) {
          assert.match(notice, /offset=3\b/)
          break
        }
        assert.ok(restored.length < content.length)
        assert.equal(Number(cursor[1]), column + [...fragment].length)
        column = Number(cursor[1])
      }
      assert.ok(column > 1)
      assert.equal(restored, content)
    })
  }

  it('空文件、超出末行及取消均有确定结果', async () => {
    const empty = await fixture('')
    assert.equal((await readFileTool.execute({ path: 'fixture.txt' }, empty.ctx)).data, '（空文件）')
    const { ctx } = await fixture('first\nsecond')
    assert.match((await readFileTool.execute({ path: 'fixture.txt', offset: 3 }, ctx)).data, /文件共 2 行/)
    assert.equal((await readFileTool.execute({ path: 'fixture.txt', column: 20 }, ctx)).isError, true)
    await assert.rejects(readFileTool.execute({ path: 'fixture.txt' }, { ...ctx, abortSignal: AbortSignal.abort() }), /abort/i)
  })

  it('读取参数拒绝错用行列和分页、无效附件及旧参数', () => {
    for (const pages of ['0', '2-1', '1-21', '1,3', '1-', '9007199254740992']) {
      assert.equal(readFileTool.inputSchema.safeParse({ path: 'a.pdf', pages }).success, false, pages)
    }
    for (const input of [
      { path: 'a.pdf', offset: 1 }, { path: 'a.png', limit: 1 }, { path: 'a.txt', pages: '1' },
      { path: 'a.pdf', column: 2 }, { path: 'a.png', column: 2 }, { path: 'a.txt', column: 0 },
      { path: 'attachment://invalid' }, { path: 'a.pdf', pageCount: 1 }, { path: 'a.png', detail: 'high' },
    ]) {
      assert.equal(readFileTool.inputSchema.safeParse(input).success, false, JSON.stringify(input))
    }
    assert.equal(readFileTool.inputSchema.safeParse({ path: 'a.txt', offset: 2, column: 10 }).success, true)
    assert.equal(readFileTool.inputSchema.safeParse({ path: 'a.pdf', pages: '3' }).success, true)
    assert.equal(readFileTool.inputSchema.safeParse({ path: 'a.pdf', pages: '21-40' }).success, true)
  })
})
