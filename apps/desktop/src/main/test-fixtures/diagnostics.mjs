import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { gunzipSync } from 'node:zlib'
import { DesktopDiagnostics } from '../diagnostics/host.ts'
import { registerDiagnosticIpc } from '../diagnostics/ipc.ts'
import { IPC } from '../../shared/ipc.ts'

const directory = process.env.WHYCODE_DIAGNOSTICS_TEST_DIR
app.setPath('userData', path.join(directory, 'profile'))
const timeout = setTimeout(() => app.exit(1), 40_000)

async function until(predicate, description) {
  const deadline = Date.now() + 5000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${description}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

await app.whenReady()
const diagnostics = new DesktopDiagnostics()
const store = diagnostics.store
await store.ready
diagnostics.sample()
app.emit('child-process-gone', {}, { type: 'Utility', reason: 'killed', exitCode: 0, name: 'fixture-worker' })
let opened = ''
let revealed = ''
const exported = path.join(directory, 'diagnostics.jsonl.gz')
dialog.showSaveDialog = async () => ({ canceled: false, filePath: exported })
shell.showItemInFolder = file => { revealed = file }
shell.openPath = async file => { opened = file; return '' }
registerDiagnosticIpc(store, state => {
  for (const window of BrowserWindow.getAllWindows()) if (!window.webContents.isDestroyed()) window.webContents.send(IPC.diagnosticsChanged, state)
})
const window = new BrowserWindow({ show: false, width: 1000, height: 850, webPreferences: {
  sandbox: true, contextIsolation: true, webviewTag: true, preload: path.join(directory, 'preload.cjs'),
} })
diagnostics.observeWindow(window)
const execute = expression => window.webContents.executeJavaScript(expression)
const click = text => execute(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === ${JSON.stringify(text)} && !button.disabled)?.click()`)
const text = () => execute('document.body.innerText')
try {
  await window.loadFile(path.join(directory, 'index.html'))
  await until(async () => (await text()).includes('已用'), '设置数据加载')
  await click('打开文件夹')
  await until(() => opened === store.files.directory, '打开日志目录')
  await until(() => execute('Array.from(document.querySelectorAll("button")).some(button=>button.textContent==="导出诊断包"&&!button.disabled)'), '按钮恢复')
  await click('导出诊断包')
  await until(() => revealed === exported, '导出完成')
  assert.match(gunzipSync(await readFile(exported)).toString(), /environment/)
  assert.match(gunzipSync(await readFile(exported)).toString(), /resource-sample/)
  assert.equal((await store.getState()).reportCount, 0, '主动终止子进程只记运行日志')

  await until(() => execute('Array.from(document.querySelectorAll("button")).some(button=>button.textContent==="清除日志"&&!button.disabled)'), '清理按钮可用')
  let release
  const gate = new Promise(resolve => { release = resolve })
  const clear = store.files.clear.bind(store.files)
  store.files.clear = async () => { await gate; return clear() }
  await click('清除日志')
  await until(() => execute('!!document.querySelector("[role=alertdialog]")'), '清理确认弹层')
  await execute('Array.from(document.querySelectorAll("[role=alertdialog] button")).find(button=>button.textContent==="清除日志").click()')
  await until(async () => (await store.getState()).busy === 'clearing', '清理开始')
  await execute('window.diagnosticFixture.visible(false)')
  await until(async () => !(await text()).includes('运行日志'), '离开设置')
  await execute('window.diagnosticFixture.visible(true)')
  await until(async () => (await text()).includes('正在清理'), '重开设置恢复进度')
  release()
  await until(async () => (await store.getState()).busy === null, '清理结束')
  assert.equal((await store.files.list()).length, 0)
  await until(async () => (await text()).includes('已用 0.0 MiB'), '清理后占用归零')

  window.setContentSize(520, 850)
  await until(() => execute('innerWidth===520'), '窄窗口布局')
  assert.equal(await execute('document.documentElement.scrollWidth <= innerWidth'), true)
  await execute('window.whycode.reportRendererDiagnostic({kind:"invalid",message:"bad"})')
  await store.flush()
  assert.equal((await store.getState()).reportCount, 0)
  await execute('window.diagnosticFixture.crash()')
  await until(async () => (await store.getState()).reportCount === 1, 'React 异常报告')
  let reports = (await store.files.list()).filter(file => file.kind === 'fault')
  const reactReport = JSON.parse(await readFile(path.join(store.files.directory, reports[0].name), 'utf8'))
  assert.equal(reactReport.fault.event, 'react-render')
  assert.match(reactReport.fault.details.componentStack, /Fixture/)
  await window.loadFile(path.join(directory, 'index.html'))
  await execute('setTimeout(()=>{throw new Error("unhandled-renderer-fixture")},0)')
  await until(async () => (await store.getState()).reportCount === 2, '未处理页面异常报告')

  const guestReady = new Promise(resolve => window.webContents.once('did-attach-webview', (_event, guest) => {
    diagnostics.observe(guest, 'browser', 'fixture-page')
    guest.once('did-finish-load', () => resolve(guest))
  }))
  await execute(`document.body.insertAdjacentHTML('beforeend', '<webview src="data:text/html,fixture" style="height:100px"></webview>')`)
  const guest = await guestReady
  const failedServer = createServer((_request, response) => response.destroy())
  await new Promise(resolve => failedServer.listen(0, '127.0.0.1', resolve))
  try {
    const failed = once(guest, 'did-fail-load')
    await assert.rejects(guest.loadURL(`http://127.0.0.1:${failedServer.address().port}/failure?token=PRIVATE_QUERY`))
    await failed
    await store.flush()
    assert.equal((await store.getState()).reportCount, 2, '普通网页加载失败只记运行日志')
    const runtimeFiles = (await store.files.list()).filter(file => file.kind === 'runtime')
    const runtimeText = (await Promise.all(runtimeFiles.map(file => readFile(path.join(store.files.directory, file.name), 'utf8')))).join('')
    assert.match(runtimeText, /load-failed/)
    assert.doesNotMatch(runtimeText, /PRIVATE_QUERY/)
  } finally { await new Promise(resolve => failedServer.close(resolve)) }
  const guestGone = once(guest, 'render-process-gone')
  guest.forcefullyCrashRenderer()
  await guestGone
  await until(async () => (await store.getState()).reportCount === 3, '网页进程崩溃报告')
  assert.equal(window.webContents.isCrashed(), false)
  const rendererGone = once(window.webContents, 'render-process-gone')
  window.webContents.forcefullyCrashRenderer()
  await rendererGone
  await until(async () => (await store.getState()).reportCount === 4, '主界面进程崩溃报告')
  reports = (await store.files.list()).filter(file => file.kind === 'fault')
  const faults = await Promise.all(reports.map(async file => JSON.parse(await readFile(path.join(store.files.directory, file.name), 'utf8')).fault))
  assert.ok(faults.some(fault => fault.source === 'browser' && fault.details.pageId === 'fixture-page' && fault.details.reason === 'crashed'))
  assert.ok(faults.some(fault => fault.source === 'renderer' && fault.event === 'process-gone' && typeof fault.details.exitCode === 'number'))
  process.stdout.write('diagnostics integration passed\n')
} catch (error) {
  process.stderr.write(String(error.stack))
  process.exitCode = 1
} finally {
  await diagnostics.close()
  window.destroy()
  clearTimeout(timeout)
  app.exit(process.exitCode ?? 0)
}
