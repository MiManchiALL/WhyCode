import assert from 'node:assert/strict'
import fs, { access, mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, type TestContext } from 'node:test'
import { localWorkspace } from '../workspace/types.ts'
import { getSessionPaths, readMetadataCache, removeMetadataCache, unavailableSessionSummary, writeMetadata } from './metadata.ts'
import { SessionStore } from './store.ts'

it('同一 metadata 的并发写入与读取依次完成，其它会话不等待', async t => {
  const { paths, journal, store } = await fixture(t)
  const other = await store.create({ workspace: localWorkspace(null), modelId: 'test:other' })
  const otherPaths = getSessionPaths(join(paths.sessionDir, '..'), other.sessionId)
  const started = deferred()
  const release = deferred()
  const rename = fs.rename
  let replacing = false
  let targetWrites = 0
  const mocked = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] !== paths.metadata) return rename(...args)
    assert.equal(replacing, false, '同一文件不能同时替换')
    targetWrites++
    replacing = true
    try {
      if (targetWrites === 1) {
        started.resolve()
        await release.promise
      }
      await rename(...args)
    } finally {
      replacing = false
    }
  })
  syncBuiltinESMExports()
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })

  const first = writeMetadata(paths.metadata, { ...journal.metadataSnapshot, title: '第一次更新' })
  await started.promise
  const second = writeMetadata(paths.metadata, { ...journal.metadataSnapshot, title: '第二次更新' })
  let readFinished = false
  const reading = readMetadataCache(paths, journal.sessionId).then(value => { readFinished = true; return value })
  const loose = unavailableSessionSummary(paths, journal.sessionId)
  const pending = Promise.allSettled([first, second, reading, loose])
  try {
    await writeMetadata(otherPaths.metadata, { ...other.metadataSnapshot, title: '独立会话' })
    assert.equal((await readMetadataCache(otherPaths, other.sessionId))?.title, '独立会话')
    assert.equal(targetWrites, 1)
    assert.equal(readFinished, false)
  } finally {
    release.resolve()
    await pending
  }
  assert.deepEqual((await pending).map(result => result.status), ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'])
  assert.equal((await reading)?.title, '第二次更新')
  assert.equal((await loose).title, '第二次更新')
  assert.equal(targetWrites, 2)
  assert.deepEqual(await readdir(paths.sessionDir), ['metadata.json', 'transcript.jsonl'])
})

it('读取句柄关闭后才替换或清理缓存，清理后的读取不会复活旧缓存', async t => {
  const { paths, journal, store } = await fixture(t)
  const other = await store.create({ workspace: localWorkspace(null), modelId: 'test:other' })
  const opened = deferred()
  const release = deferred()
  const originalRead = fs.readFile
  const rename = fs.rename
  let reading = false
  let intercepted = false
  const mockedRead = t.mock.method(fs, 'readFile', async (
    path: Parameters<typeof fs.readFile>[0], options?: Parameters<typeof fs.readFile>[1],
  ) => {
    if (path !== paths.metadata || intercepted) return originalRead(path, options)
    intercepted = true
    const handle = await open(paths.metadata, 'r')
    reading = true
    try {
      opened.resolve()
      await release.promise
      return await handle.readFile(options)
    } finally {
      await handle.close()
      reading = false
    }
  })
  const mockedRename = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === paths.metadata) assert.equal(reading, false, '替换前必须关闭本进程的读取句柄')
    await rename(...args)
  })
  syncBuiltinESMExports()
  t.after(() => { mockedRead.mock.restore(); mockedRename.mock.restore(); syncBuiltinESMExports() })

  const before = readMetadataCache(paths, journal.sessionId)
  await opened.promise
  const writing = writeMetadata(paths.metadata, { ...journal.metadataSnapshot, title: '更新后' })
  const removing = removeMetadataCache(paths.metadata)
  const after = readMetadataCache(paths, journal.sessionId)
  const pending = Promise.allSettled([before, writing, removing, after])
  try {
    await other.sealMetadataCache()
    assert.equal(JSON.parse(await originalRead(paths.metadata, 'utf8')).title, journal.metadataSnapshot.title)
  } finally {
    release.resolve()
    await pending
  }
  assert.deepEqual((await pending).map(result => result.status), ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'])
  assert.equal((await before)?.sessionId, journal.sessionId)
  assert.equal(await after, null)
  assert.deepEqual(await readdir(paths.sessionDir), ['transcript.jsonl'])
})

it('替换失败保留原缓存并清理临时文件，后续写入仍可成功', async t => {
  const { paths, journal } = await fixture(t)
  const original = await readFile(paths.metadata, 'utf8')
  const rename = fs.rename
  let failure: Error | null = null
  const mocked = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === paths.metadata && failure) throw failure
    await rename(...args)
  })
  syncBuiltinESMExports()
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
  for (const code of ['EPERM', 'EBUSY']) {
    failure = Object.assign(new Error('文件占用'), { code })
    await assert.rejects(writeMetadata(paths.metadata, { ...journal.metadataSnapshot, title: '尚未提交' }), failure)
    assert.equal(await readFile(paths.metadata, 'utf8'), original)
    assert.deepEqual(await readdir(paths.sessionDir), ['metadata.json', 'transcript.jsonl'])
  }
  failure = null
  await writeMetadata(paths.metadata, { ...journal.metadataSnapshot, title: '重新提交成功' })
  assert.equal((await readMetadataCache(paths, journal.sessionId))?.title, '重新提交成功')
})

it('JSONL 已提交后缓存失败只清理缓存，冷加载仍能恢复新状态', async t => {
  const { paths, journal, store } = await fixture(t)
  const rename = fs.rename
  let locked = true
  const mocked = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === paths.metadata && locked) throw Object.assign(new Error('文件占用'), { code: 'EPERM' })
    await rename(...args)
  })
  syncBuiltinESMExports()
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports() })
  await journal.updateModelSelection('test:new-model', 'high')
  assert.equal(journal.metadataSnapshot.modelId, 'test:new-model')
  await assert.rejects(access(paths.metadata), { code: 'ENOENT' })
  assert.match(await readFile(paths.transcript, 'utf8'), /test:new-model/)

  locked = false
  assert.equal((await store.open(journal.sessionId)).metadataSnapshot.modelId, 'test:new-model')
  assert.equal((await readMetadataCache(paths, journal.sessionId))?.modelId, 'test:new-model')
  assert.deepEqual(await readdir(paths.sessionDir), ['metadata.json', 'transcript.jsonl'])
})

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-metadata-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new SessionStore(root)
  const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
  return { store, journal, paths: getSessionPaths(root, journal.sessionId) }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
