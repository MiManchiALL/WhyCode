import assert from 'node:assert/strict'
import { it, type TestContext } from 'node:test'
import { mkdtemp, readFile, writeFile, mkdir, rm, readdir, truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { DiagnosticFiles } from './files.ts'
import { DiagnosticStore } from './store.ts'
import { diagnosticText, formatDiagnostic, formatFault, utf8Prefix } from './format.ts'
import { RuntimeDiagnostics } from './runtime.ts'
import { DIAGNOSTIC_LIMITS } from '../../shared/diagnostics.ts'

const epoch = Date.UTC(2026, 10, 4)
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'whycode-diagnostics-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
async function runtimeLines(store: DiagnosticStore): Promise<string> {
  const files = (await store.files.list()).filter(file => file.kind === 'runtime')
  return (await Promise.all(files.map(file => readFile(join(store.files.directory, file.name), 'utf8')))).join('')
}

it('按实际 UTF-8 字节轮转，含当前文件最多四份；重启续写、过期清理不删除无关文件', async t => {
  const directory = await fixture(t)
  const policy = { ...DIAGNOSTIC_LIMITS, runtimeFileBytes: 1024 }
  const files = new DiagnosticFiles(directory, policy)
  await files.initialize(epoch)
  await writeFile(join(directory, 'notes.txt'), 'keep')
  await mkdir(join(directory, `runtime-${epoch}-${randomUUID()}.jsonl`))
  for (let i = 0; i < 9; i++) await files.append(JSON.stringify({ i, text: '中文'.repeat(130) }) + '\n', epoch + i)
  let entries = await files.list()
  assert.equal(entries.length, 4)
  assert.ok(entries.every(file => file.bytes <= 1024))
  assert.deepEqual(await Promise.all(entries.map(async file => JSON.parse(await readFile(join(directory, file.name), 'utf8')).i)), [5, 6, 7, 8])
  const restored = new DiagnosticFiles(directory, policy)
  await restored.initialize(epoch + 20)
  await restored.append('{"restart":true}\n', epoch + 21)
  assert.equal((await restored.list()).length, 4)
  assert.match(await readFile(join(directory, entries.at(-1)!.name), 'utf8'), /restart/)
  const oversized = join(directory, `runtime-${epoch + 30}-${randomUUID()}.jsonl`)
  await writeFile(oversized, '')
  await truncate(oversized, 1025)
  await restored.prune(epoch + 40)
  assert.equal((await restored.list()).length, 4)
  await restored.prune(epoch + 15 * 86_400_000)
  entries = await restored.list()
  assert.equal(entries.length, 0)
  assert.equal(await readFile(join(directory, 'notes.txt'), 'utf8'), 'keep')
  await restored.append('{"fresh":true}\n', epoch + 15 * 86_400_000)
  assert.equal((await restored.list()).length, 1)
})

it('故障报告保留最近十份、单份限额，不按十四天清除；同步退出报告也遵守容量', async t => {
  const directory = await fixture(t)
  const files = new DiagnosticFiles(directory)
  await files.initialize(epoch)
  for (let i = 0; i < 12; i++) {
    files.report(JSON.stringify({ i, text: 'x'.repeat(DIAGNOSTIC_LIMITS.reportBytes - 80) }), epoch)
    const current = await files.list()
    assert.ok(current.length <= 10)
    assert.ok(current.reduce((sum, file) => sum + file.bytes, 0) <= 10 * DIAGNOSTIC_LIMITS.reportBytes)
  }
  files.report('{"i":12}', epoch)
  const entries = await files.list()
  assert.equal(entries.length, 10)
  assert.deepEqual(await Promise.all(entries.map(async file => JSON.parse(await readFile(join(directory, file.name), 'utf8')).i)), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  assert.throws(() => files.report('x'.repeat(DIAGNOSTIC_LIMITS.reportBytes + 1), epoch), /容量/)
  await files.prune(epoch + 30 * 86_400_000)
  assert.equal((await files.list()).length, 10)
})

it('异常中断留下的半条记录在重启时被修剪并留下说明，后续 JSONL 仍可逐条读取', async t => {
  const directory = await fixture(t)
  const files = new DiagnosticFiles(directory)
  await files.initialize(epoch)
  await files.append('{"complete":true}\n', epoch)
  const current = (await files.list())[0]!
  await writeFile(join(directory, current.name), '{"partial":"interrupted', { flag: 'a' })
  const store = new DiagnosticStore({ directory, environment: {}, now: () => epoch + 10 })
  await store.ready
  store.log({ source: 'test', level: 'info', event: 'resumed' })
  await store.flush()
  const lines = (await runtimeLines(store)).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines[0], { complete: true })
  assert.ok(lines.some(line => line.event === 'incomplete-record-discarded'))
  assert.equal(lines.at(-1).event, 'resumed')
  await store.close()
})

it('格式化保留堆栈与 cause，脱敏 URL/凭据，超大和循环数据有界且仍是有效 JSON', () => {
  const error = new Error('fetch https://user:pass@example.test/a?ticket=secret#private failed', { cause: new Error('password="hidden"') })
  const cycle: Record<string, unknown> = { error, apiKey: 'hidden-key', Authorization: 'Bearer hidden-header', token: 'hidden-token', messages: ['PRIVATE_CHAT'] }
  cycle.self = cycle
  const line = formatDiagnostic({ source: 'main', level: 'error', event: 'failed', details: cycle }, epoch, 'run')
  assert.match(line, /example.test\/a/)
  assert.match(line, /cause/)
  assert.match(line, /stack/)
  assert.doesNotMatch(line, /user:pass|ticket=secret|private|hidden-key|hidden-header|hidden-token|PRIVATE_CHAT/)
  assert.equal(JSON.parse(line).details.apiKey, '[redacted]')
  assert.doesNotMatch(diagnosticText('Cookie: session=secret; key=private\nnext'), /secret|private/)
  assert.doesNotMatch(diagnosticText('{"Cookie":"session=secret","Authorization":"Basic private"}'), /secret|private/)
  const huge = formatDiagnostic({ source: 'a', level: 'error', event: 'large', details: { text: '\u0000😀'.repeat(100_000) } }, epoch, 'run')
  assert.ok(Buffer.byteLength(huge) <= 64 * 1024)
  assert.doesNotThrow(() => JSON.parse(huge))
  assert.equal(utf8Prefix('你😀好', 6), '你')
  const report = formatFault(line, '{}', Array.from({ length: 500 }, () => line), 64 * 1024)
  assert.ok(Buffer.byteLength(report) <= 64 * 1024)
  assert.equal(JSON.parse(report).fault.event, 'failed')
  assert.ok(JSON.parse(report).omittedRecentRecords > 0)
  const tree = Array.from({ length: 32 }, () => Array.from({ length: 32 }, () => Array(32).fill('x'.repeat(100_000))))
  const wide = formatDiagnostic({ source: 'test', level: 'error', event: 'wide', details: { tree } }, epoch, 'run')
  assert.ok(Buffer.byteLength(wide) <= 64 * 1024)
  assert.match(wide, /truncated/)
})

it('重复报错保留首次详情、次数和时间，故障仅生成一份；导出为可解压的本地诊断包', async t => {
  const root = await fixture(t)
  const store = new DiagnosticStore({ directory: join(root, 'logs'), environment: { appVersion: 'test' }, now: () => epoch })
  await store.ready
  for (let i = 0; i < 100; i++) store.fault({ level: 'error', source: 'renderer', event: 'render-failed', details: { error: new Error('fixture failure') } })
  await store.flush()
  assert.equal((await store.getState()).reportCount, 1)
  const logs = await runtimeLines(store)
  assert.match(logs, /"additionalCount":99/)
  const destination = join(root, 'export.jsonl.gz')
  await store.export(destination)
  const exported = gunzipSync(await readFile(destination)).toString()
  assert.match(exported, /fault-report/)
  assert.match(exported, /fixture failure/)
  assert.ok(exported.split('\n').filter(Boolean).every(line => JSON.parse(line)))
  assert.equal((await store.getState()).busy, null)
  await assert.rejects(store.export(join(root, 'missing', 'out.gz')))
  assert.equal((await store.getState()).error, null, '导出失败不能停掉运行日志')
  await assert.rejects(store.export(join(root, 'logs', 'out.gz')), /目录之外/)
  const impossible = join(root, 'directory.gz')
  await mkdir(impossible)
  await assert.rejects(store.export(impossible))
  assert.equal((await readdir(root)).filter(name => name.endsWith('.tmp')).length, 0)
  await store.close()
})

it('磁盘阻塞时队列有界并记录丢弃数量，写入中清理等待在途写入且旧记录不会复活', async t => {
  const directory = await fixture(t)
  const store = new DiagnosticStore({ directory, environment: {}, now: () => epoch })
  await store.ready
  const append = store.files.append.bind(store.files)
  let unblock!: () => void
  let entered!: () => void
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  store.files.append = async (body, time) => { entered(); await blocked; return append(body, time) }
  store.log({ source: 'test', level: 'info', event: 'in-flight-old' })
  await started
  for (let i = 0; i < 1000; i++) store.log({ source: 'test', level: 'info', event: 'old-queued', details: { i, text: 'x'.repeat(4096) } })
  assert.ok((await store.getState()).droppedRecords > 0)
  const clearing = store.clear()
  assert.equal((await store.getState()).busy, 'clearing')
  await assert.rejects(store.clear(), /正在处理/)
  store.log({ source: 'test', level: 'info', event: 'after-clear' })
  store.fault({ source: 'test', level: 'error', event: 'fault-after-clear' })
  unblock()
  await clearing
  await store.flush()
  const logs = await runtimeLines(store)
  assert.doesNotMatch(logs, /in-flight-old|old-queued/)
  assert.match(logs, /after-clear/)
  const report = (await store.files.list()).find(file => file.kind === 'fault')!
  assert.doesNotMatch(await readFile(join(directory, report.name), 'utf8'), /in-flight-old|old-queued/)
  assert.equal((await store.getState()).busy, null)
  await store.close()
})

it('写入失败如实投影，修复并清理后恢复；停止写入时仍能保存主进程退出现场', async t => {
  const directory = await fixture(t)
  const store = new DiagnosticStore({ directory, environment: {}, now: () => epoch })
  await store.ready
  const append = store.files.append.bind(store.files)
  store.files.append = async () => { throw new Error('fixture disk full') }
  store.log({ source: 'test', level: 'info', event: 'failed-write' })
  await store.flush()
  assert.match((await store.getState()).error!, /disk full/)
  store.fault({ source: 'renderer', level: 'error', event: 'render-failed' })
  await store.flush()
  assert.equal((await store.getState()).reportCount, 1, '运行日志失败后仍尝试保存故障现场')
  store.fatal({ source: 'main', level: 'error', event: 'uncaught', details: { error: new Error('fatal fixture') } })
  assert.equal((await store.files.list()).filter(file => file.kind === 'fault').length, 2)
  store.files.append = append
  await store.clear()
  store.log({ source: 'test', level: 'info', event: 'recovered' })
  await store.flush()
  assert.equal((await store.getState()).error, null)
  assert.match(await runtimeLines(store), /recovered/)
  await store.close()
})

it('高频记录在磁盘阻塞期间不会无限积压，恢复后持久化遗漏计数；清理失败不报成功', async t => {
  const store = new DiagnosticStore({ directory: await fixture(t), environment: {} })
  await store.ready
  const append = store.files.append.bind(store.files)
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  store.files.append = async (body, time) => { entered(); await blocked; return append(body, time) }
  store.log({ source: 'test', level: 'info', event: 'first' })
  await started
  for (let i = 0; i < 2000; i++) store.log({ source: 'test', level: 'info', event: 'burst', details: { i, text: 'x'.repeat(4096) } })
  release()
  await store.flush()
  const logs = await runtimeLines(store)
  assert.ok(Buffer.byteLength(logs) < 1024 * 1024 + 64 * 1024, '队列至多 1 MiB，加在途批次和遗漏计数')
  assert.match(logs, /dropped-records/)
  assert.ok((await store.getState()).droppedRecords > 1500)
  const clear = store.files.clear.bind(store.files)
  store.files.clear = async () => { throw new Error('fixture cleanup denied') }
  await assert.rejects(store.clear(), /cleanup denied/)
  assert.equal((await store.getState()).busy, null)
  assert.match((await store.getState()).error!, /cleanup denied/)
  assert.ok((await store.getState()).runtimeBytes > 0)
  store.files.clear = clear
  await store.clear()
  await store.close()
})

it('Core 事件仅记录关键元数据与耗时，不复制消息、工具输入或输出', async t => {
  const store = new DiagnosticStore({ directory: await fixture(t), environment: {} })
  const runtime = new RuntimeDiagnostics(store)
  runtime.record('runtime', 'session', { type: 'text-delta', text: 'PRIVATE_CHAT' }, new Date(epoch).toISOString())
  runtime.record('runtime', 'session', { type: 'tool-start', toolUseId: 'call', toolName: 'Browser', input: 'PRIVATE_INPUT' }, new Date(epoch).toISOString())
  runtime.record('runtime', 'session', { type: 'tool-end', toolUseId: 'call', isError: false, result: 'PRIVATE_OUTPUT' }, new Date(epoch + 250).toISOString())
  await store.flush()
  const logs = await runtimeLines(store)
  assert.match(logs, /"durationMs":250/)
  assert.match(logs, /"toolName":"Browser"/)
  assert.doesNotMatch(logs, /PRIVATE_/)
  await store.close()
})
