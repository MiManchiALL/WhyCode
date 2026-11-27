import assert from 'node:assert/strict'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'

const directory = process.argv[2]
app.setPath('userData', path.join(directory, 'profile'))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 440, height: 360, webPreferences: { backgroundThrottling: false } })
  await win.loadFile(path.join(directory, 'index.html'))
  const run = (fn, ...args) => win.webContents.executeJavaScript(`(${fn})(${args.map(arg => JSON.stringify(arg)).join(',')})`)
  const show = (session, tasks) => run((key, statuses) => TaskMenuFixture.show(key, statuses), session, tasks)
  const click = label => run(name => {
    const button = [...document.querySelectorAll('button')].find(el => (el.ariaLabel ?? el.textContent) === name)
    if (!button) throw new Error('找不到按钮 ' + name)
    button.focus()
    button.click()
  }, label)
  const rows = () => run(() => [...document.querySelectorAll('.wc-background-task-label')].map(el => el.textContent))
  const clear = '清空已结束任务'
  const tasks = {
    build: 'running', watch: 'stopping', ok: 'completed', error: 'failed', stop: 'stopped', lost: 'interrupted',
    ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => ['history-' + i, 'completed'])),
  }

  await show('A', tasks)
  await click('2 个后台任务运行中')
  assert.deepEqual(await rows(), Object.keys(tasks))
  assert.ok(await run(name => {
    const list = document.querySelector('.wc-background-task-list')
    const button = [...document.querySelectorAll('button')].find(el => el.textContent === name)
    const rect = button.getBoundingClientRect()
    return list.scrollHeight > list.clientHeight && rect.top >= list.getBoundingClientRect().bottom
      && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
  }, clear), '窄窗口中列表独立滚动，清空按钮始终可见')
  await click(clear)
  assert.deepEqual(await rows(), ['build', 'watch'])
  assert.ok(await run(() => document.activeElement.matches('[role="dialog"]')))
  assert.equal(await run(name => [...document.querySelectorAll('button')].some(el => el.textContent === name), clear), false)

  await show('B', { ok: 'completed' })
  await click('1 个后台任务')
  assert.deepEqual(await rows(), ['ok'])
  await show('A', { ...tasks, watch: 'stopped' })
  await click('1 个后台任务运行中')
  assert.deepEqual(await rows(), ['build', 'watch'])
  await click(clear)
  assert.deepEqual(await rows(), ['build'])

  await show('A', { ...tasks, watch: 'stopped', build: 'completed' })
  assert.deepEqual(await rows(), ['build'])
  await click(clear)
  assert.ok(await run(() => document.querySelector('.wc-background-tasks-trigger') === null))
  assert.equal(await run(() => document.activeElement.ariaLabel), '展开侧边栏')
  assert.deepEqual(await run(() => TaskMenuFixture.stopCalls), [])

  const settled = { ...tasks, watch: 'stopped', build: 'completed', next: 'completed' }
  await show('A', settled)
  await click('1 个后台任务')
  assert.deepEqual(await rows(), ['next'])
  await win.loadFile(path.join(directory, 'index.html'))
  await show('A', settled)
  await click(`${Object.keys(settled).length} 个后台任务`)
  assert.deepEqual(await rows(), Object.keys(settled), '重新打开后按宿主快照显示')
  console.log('background task menu passed')
  win.destroy()
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
