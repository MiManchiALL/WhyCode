import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { it } from 'node:test'
import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc.ts'
import { installComposerWindowLifecycle } from './composer-window-lifecycle.ts'

function fixture() {
  const window = new EventEmitter()
  const webContents = Object.assign(new EventEmitter(), {
    mainFrame: {}, isDestroyed: () => false,
    send: (channel: string, state: string) => requests.push([channel, state]),
  })
  const requests: string[][] = []
  let closed = false
  const close = () => {
    let prevented = false
    window.emit('close', { preventDefault: () => { prevented = true } })
    if (!prevented) closed = true
  }
  installComposerWindowLifecycle(Object.assign(window, { webContents, close }) as unknown as BrowserWindow)
  const reply = (state: string, senderFrame = webContents.mainFrame) => {
    webContents.emit('ipc-message', { senderFrame }, IPC.composerPersistence, state)
  }
  return { window, webContents, requests, close, reply, get closed() { return closed } }
}

it('关闭只发起一次落盘请求，收到当前主页面成功确认后才关闭', () => {
  const f = fixture()
  f.reply('ready')
  f.close()
  f.close()
  assert.equal(f.closed, false)
  assert.deepEqual(f.requests, [[IPC.composerPersistence, 'flush']])
  f.reply('saved', {})
  assert.equal(f.closed, false)
  f.reply('saved')
  assert.equal(f.closed, true)
})

it('保存失败保留窗口，下一次关闭可以重新保存', () => {
  const f = fixture()
  f.reply('ready')
  f.close()
  f.reply('failed')
  assert.equal(f.closed, false)
  f.close()
  assert.equal(f.requests.length, 2)
  f.reply('saved')
  assert.equal(f.closed, true)
})

it('未就绪或已退出的页面不阻塞关闭，导航清除上一页的确认状态', () => {
  const empty = fixture()
  empty.close()
  assert.equal(empty.closed, true)
  const f = fixture()
  f.reply('ready')
  f.close()
  f.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  f.reply('saved')
  assert.equal(f.closed, false)
  f.close()
  assert.equal(f.closed, true)
})
