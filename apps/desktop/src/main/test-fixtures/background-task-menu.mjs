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
  const clearSelector = `button[aria-label="${clear}"]`
  assert.ok(await run(selector => {
    const list = document.querySelector('.wc-background-task-list')
    list.scrollTop = list.scrollHeight
    const button = document.querySelector(selector)
    const rect = button.getBoundingClientRect()
    return list.scrollTop > 0 && button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
  }, clearSelector), '窄窗口滚到列表末尾仍能点击清空图标')
  await click(clear)
  assert.deepEqual(await rows(), ['build', 'watch'])
  assert.ok(await run(() => document.activeElement.matches('[role="dialog"]')))
  assert.ok(await run(selector => !document.querySelector(selector), clearSelector))

  await show('B', { ok: 'completed' })
  await click('1 个后台任务')
  assert.deepEqual(await rows(), ['ok'])
  assert.deepEqual(await run(selector => {
    const button = document.querySelector(selector)
    const row = document.querySelector('.wc-background-task-row').getBoundingClientRect()
    const rect = button.getBoundingClientRect()
    return {
      iconOnly: button.textContent.trim() === '' && !!button.querySelector('svg'),
      labelled: button.title.includes(button.ariaLabel),
      target: [button.offsetWidth, button.offsetHeight],
      sameRow: rect.top >= row.top && rect.bottom <= row.bottom,
    }
  }, clearSelector), { iconOnly: true, labelled: true, target: [24, 24], sameRow: true })
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
