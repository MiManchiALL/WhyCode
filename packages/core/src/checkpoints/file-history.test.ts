import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { it, type TestContext } from 'node:test'
import { localWorkspaceIO, type WorkspaceIO } from '../workspace/io.ts'
import { captureFileState, restoreFileState } from './file-history.ts'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-file-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, blobs: join(root, 'blobs') }
}

it('多文件快照与恢复只使用流，完整 blob 可按摘要去重并保留全部字节', async t => {
  const { root, blobs } = await fixture(t)
  const bytes = Buffer.alloc(4 * 1024 * 1024, 255)
  bytes[0] = 0
  const first = join(root, 'first.bin'), second = join(root, 'second.bin')
  await writeFile(first, bytes)
  await writeFile(second, bytes)
  const io: WorkspaceIO = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs,
    readFile: async () => assert.fail('快照不能整文件读入内存'),
    writeFile: async () => assert.fail('恢复不能整文件写出'),
  } }
  const states = await Promise.all([first, second].map(path => captureFileState(path, blobs, io)))
  const expectedHash = createHash('sha256').update(bytes).digest('hex')
  assert.deepEqual(await readdir(blobs), [expectedHash])
  for (const state of states) {
    assert.equal(state.contentHash, expectedHash)
    assert.equal(state.size, bytes.length)
    await rm(state.path)
    await restoreFileState(state, blobs, io)
    assert.deepEqual(await readFile(state.path), bytes)
  }
  assert.deepEqual((await readdir(root)).sort(), ['blobs', 'first.bin', 'second.bin'])
})

it('快照流中断不发布残缺 blob，恢复写入失败保留当前文件并清理临时文件', async t => {
  const { root, blobs } = await fixture(t)
  const file = join(root, 'keep.txt')
  await writeFile(file, 'before')
  const brokenRead: WorkspaceIO = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs,
    createReadStream: () => Readable.from((async function* () {
      yield Buffer.from('partial')
      throw new Error('读取中断')
    })()),
  } }
  await assert.rejects(captureFileState(file, blobs, brokenRead), /读取中断/)
  assert.deepEqual(await readdir(blobs), [])
  const state = await captureFileState(file, blobs)
  await writeFile(file, 'current')
  const brokenWrite: WorkspaceIO = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs,
    createWriteStream: () => new Writable({ write(_chunk, _encoding, callback) { callback(new Error('写入失败')) } }),
  } }
  await assert.rejects(restoreFileState(state, blobs, brokenWrite), /写入失败/)
  assert.equal(await readFile(file, 'utf8'), 'current')
  assert.deepEqual((await readdir(root)).sort(), ['blobs', 'keep.txt'])
})
