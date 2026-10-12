const { app, BrowserWindow } = require('electron')

app.setPath('userData', process.env.WHYCODE_SCREENSHOT_TEST_DIR)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, opacity: 0, skipTaskbar: true, width: 480, height: 320 })
  window.setIgnoreMouseEvents(true)
  await window.loadURL('data:text/html,<title>WhyCode Screenshot Test Window</title><body style="background:tomato">Screenshot fixture</body>')
  process.send({ handle: window.getNativeWindowHandle().readBigUInt64LE().toString(), title: window.getTitle() })
  let duplicate
  process.on('message', async state => {
    if (state === 'duplicate') {
      duplicate = new BrowserWindow({ show: false, opacity: 0, skipTaskbar: true, width: 600, height: 400 })
      await duplicate.loadURL('data:text/html,<title>WhyCode Screenshot Test Window</title>')
    }
    if (state === 'remove-duplicate') { duplicate.destroy(); duplicate = undefined }
    if (state === 'launcher-title') window.setTitle('WhyCode Launcher Child')
    if (state === 'original-title') window.setTitle('WhyCode Screenshot Test Window')
    if (state === 'background') window.showInactive()
    if (state === 'minimized') window.minimize()
    if (state === 'hidden') window.hide()
    setTimeout(() => process.send({ state }), 350)
  })
})
process.on('disconnect', () => app.quit())
