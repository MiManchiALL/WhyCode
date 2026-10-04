import assert from 'node:assert/strict'
import { it } from 'node:test'
import { browserAddress, browserShortcut, isBrowserUrl } from '../shared/browser.ts'
import { browserGuestPreferences, browserNavigationAllowed, browserRequestAllowed } from './browser-policy.ts'

it('地址栏区分网址、本机服务与搜索，拒绝脚本、文件与内嵌凭据', () => {
  assert.equal(browserAddress(' example.com/a?q=b '), 'https://example.com/a?q=b')
  assert.equal(browserAddress('localhost:3000/game'), 'http://localhost:3000/game')
  assert.equal(browserAddress('127.0.0.1:5174'), 'http://127.0.0.1:5174/')
  assert.equal(browserAddress('[::1]:3000'), 'http://[::1]:3000/')
  assert.equal(browserAddress('http://172.22.231.25:8080'), 'http://172.22.231.25:8080/')
  assert.equal(browserAddress('布局 配色'), 'https://www.bing.com/search?q=%E5%B8%83%E5%B1%80%20%E9%85%8D%E8%89%B2')
  for (const url of ['file:///C:/Windows/a', 'javascript:alert(1)', 'data:text/html,a', 'https://user:secret@example.com', 'whycode-preview://id/a']) {
    assert.throws(() => browserAddress(url))
    assert.equal(isBrowserUrl(url), false)
  }
})

it('网页允许网络、表单与内存资源，不能读取应用页面或自定义文件协议', () => {
  const app = 'http://localhost:5173/'
  for (const url of ['http://localhost:5174', 'https://example.com', 'wss://example.com/ws', 'blob:https://example.com/id', 'data:image/png;base64,a']) {
    assert.equal(browserRequestAllowed(url, app), true, url)
  }
  for (const url of ['http://127.0.0.1:5173/src/App.tsx', 'ws://[::1]:5173/', 'file:///C:/secret', 'whycode-attachment://id/a', 'https://user:secret@example.com']) {
    assert.equal(browserRequestAllowed(url, app), false, url)
  }
  assert.equal(browserNavigationAllowed('data:text/html,content', app), false)
  assert.equal(browserNavigationAllowed('https://example.com', app), true)
  assert.equal(browserNavigationAllowed('about:blank#lease', app), true)
})

it('guest 的 DOM 参数不能启用 Node、任意 preload 或关闭隔离', () => {
  const preferences = { preload: 'file:///evil.js', nodeIntegration: true, webSecurity: false,
    nodeIntegrationInSubFrames: true, sandbox: false, session: {}, partition: 'default', disablePopups: false }
  browserGuestPreferences(preferences, 'persist:test')
  assert.equal('preload' in preferences, false)
  assert.equal('session' in preferences, false)
  assert.equal(preferences.partition, 'persist:test')
  assert.equal(preferences.nodeIntegration, false)
  assert.equal(preferences.nodeIntegrationInSubFrames, false)
  assert.equal(preferences.webSecurity, true)
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.disablePopups, false)
})

it('开发者工具资源仅供所属网页的原生检查器读取，网页本身不能导航或请求', () => {
  const url = 'devtools://devtools/bundled/devtools_app.html'
  assert.equal(browserRequestAllowed(url), false)
  assert.equal(browserNavigationAllowed(url), false)
  assert.equal(browserRequestAllowed(url, undefined, true), true)
  assert.equal(browserRequestAllowed('file:///C:/secret', undefined, true), false)
  assert.equal(browserRequestAllowed('devtools://other/bundled/a', undefined, true), false)
})

it('浏览器快捷键覆盖导航、标签与缩放，输入法组合与网页常用编辑键保持原义', () => {
  assert.equal(browserShortcut({ key: 'l', control: true }), 'address')
  assert.equal(browserShortcut({ key: 'r', meta: true, shift: true }), 'reload-clean')
  assert.equal(browserShortcut({ key: 'ArrowLeft', alt: true }), 'back')
  assert.equal(browserShortcut({ key: 't', control: true }), 'new-tab')
  assert.equal(browserShortcut({ key: 'w', control: true }), 'close-tab')
  assert.equal(browserShortcut({ key: '+', control: true, shift: true }), 'zoom-in')
  assert.equal(browserShortcut({ key: 'c', control: true }), null)
  assert.equal(browserShortcut({ key: 'f', control: true, isComposing: true }), null)
})
