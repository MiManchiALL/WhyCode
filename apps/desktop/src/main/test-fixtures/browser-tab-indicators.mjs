import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function checkBrowserTabIndicators({ run, finish, execute, until, agent, guests, url, win }) {
  await execute('fixture.session("alpha")')
  await execute(`fixture.open(${JSON.stringify(url)})`)
  await until(() => agent.pages.list('alpha').some(page => guests.get(page.id)?.getURL() === url), 'audio page loaded')
  const page = agent.pages.list('alpha')[0]
  const guest = guests.get(page.id)
  const status = () => execute(`(() => {
    const tab = document.querySelector('[data-panel-tab]');
    return tab && { agent: tab.dataset.agentControlled === 'true', color: getComputedStyle(tab).backgroundColor,
      audible: !!tab.querySelector('[aria-label="正在播放声音"]') };
  })()`)
  await until(async () => (await status())?.agent === false, 'user tab ready')
  const gray = (await status()).color
  assert.equal((await status()).audible, false, '静音网页不显示声音图标')
  await guest.executeJavaScript(`(async () => {
    document.title = '声音与 Agent 控制状态验证：很长的网页标题不会挤掉声音图标和关闭按钮';
    window.audio = new AudioContext();
    const oscillator = audio.createOscillator();
    window.level = audio.createGain(); level.gain.value = 0.001;
    oscillator.connect(level).connect(audio.destination); oscillator.start();
    await audio.resume();
  })()`, true)
  await until(async () => (await status())?.audible, 'Web Audio sound indicator')
  await guest.executeJavaScript('audio.suspend()')
  await until(async () => !(await status())?.audible, 'paused sound indicator removed')
  await guest.executeJavaScript('audio.resume()', true)
  await until(async () => (await status())?.audible, 'resumed sound indicator')
  await guest.executeJavaScript('level.gain.value = 0; null')
  await until(async () => !(await status())?.audible, 'silent running audio has no indicator')
  await guest.executeJavaScript('level.gain.value = 0.001; null')
  await until(async () => (await status())?.audible, 'sound restored')

  assert.equal((await run('indicators', 'await browser.open();')).isError, false)
  await until(async () => (await status())?.agent, 'controlled tab blue')
  const blue = (await status()).color
  assert.notEqual(blue, gray)
  assert.equal(await execute(`getComputedStyle(document.querySelector('[aria-label="Agent 正在操作此网页"]')).backgroundColor`),
    blue, 'Agent 状态标记与活动标签共用同一雾霾蓝')
  assert.equal((await status()).audible, true, '接管保留原网页的声音状态')
  await execute('fixture.narrow()')
  await until(() => execute(`document.querySelector('[aria-label="Agent 浏览器"]').getBoundingClientRect().width === 300`), 'narrow tab layout ready')
  const layout = await execute(`(() => {
    const tab = document.querySelector('[data-panel-tab]');
    const icon = tab.querySelector('[aria-label="正在播放声音"]').getBoundingClientRect();
    const close = tab.lastElementChild.getBoundingClientRect();
    const title = tab.querySelector('.truncate');
    return { iconVisible: icon.width > 0 && icon.right <= close.left,
      closeVisible: close.right <= tab.getBoundingClientRect().right, truncated: title.scrollWidth > title.clientWidth };
  })()`)
  assert.deepEqual(layout, { iconVisible: true, closeVisible: true, truncated: true })
  await execute('document.querySelector("[data-panel-tab] button").focus()')
  assert.equal(await execute('document.activeElement.matches("[data-panel-tab] button")'), true, '标签仍可键盘聚焦')
  if (process.env.WHYCODE_BROWSER_REVIEW_DIR) {
    await mkdir(process.env.WHYCODE_BROWSER_REVIEW_DIR, { recursive: true })
    await writeFile(path.join(process.env.WHYCODE_BROWSER_REVIEW_DIR, 'tab-agent-audio.png'),
      (await win.webContents.capturePage({ x: 100, y: 0, width: 300, height: 130 })).toPNG())
  }
  await finish('indicators')
  await until(async () => (await status())?.agent === false, 'handoff restores gray')
  assert.equal((await status()).color, gray)
  assert.equal((await status()).audible, true, '交还同一 DOM 后声音图标保留')
  assert.equal(guest.isDestroyed(), false)
  const sync = agent.pages.sync.bind(agent.pages)
  const action = agent.pages.action.bind(agent.pages)
  let resumeView
  let closed = false
  // 固定关闭与导航元数据的交错：旧视图同步在关闭之后抵达 Main。
  agent.pages.sync = (owner, view) => {
    if (!resumeView && view.pages.some(page => page.url === 'about:blank')) {
      resumeView = () => sync(owner, view)
      agent.pages.sync = sync
    } else sync(owner, view)
  }
  agent.pages.action = (owner, request) => {
    action(owner, request)
    if (request.type === 'stop') { resumeView(); closed = true }
  }
  try {
    await guest.loadURL('about:blank')
    await until(() => !!resumeView, 'navigation metadata queued')
    await until(async () => !(await status())?.audible, 'navigation clears sound indicator')
    await execute('fixture.close()')
    await until(() => closed, 'close reaches host')
    assert.equal(agent.pages.list('alpha').length, 0, '关闭后的元数据同步不得重新创建网页')
  } finally { agent.pages.sync = sync; agent.pages.action = action }
  await until(() => execute('!document.querySelector("[data-panel-tab]")'), 'closed tab removed', async () => ({
    state: await execute('fixture.state()'), pages: agent.pages.list('alpha'), destroyed: guest.isDestroyed(),
    feedback: await execute('window.lastFeedback'), confirmation: await execute('document.querySelector("[role=alertdialog]")?.textContent'),
  }))
  await until(() => guest.isDestroyed(), 'audio guest released')
  guests.onAudioStateChanged(page.id, true)
  assert.equal(await execute(`!!document.querySelector('[aria-label="正在播放声音"]')`), false, '关闭后的迟到声音通知不恢复标签')
  await execute('fixture.session("alpha")')
}
