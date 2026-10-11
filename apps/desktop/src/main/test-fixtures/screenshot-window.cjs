const { app, BrowserWindow } = require('electron')

app.setPath('userData', process.env.WHYCODE_SCREENSHOT_TEST_DIR)
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, opacity: 0, skipTaskbar: true, width: 480, height: 320 })
  window.setIgnoreMouseEvents(true)
  await window.loadURL('data:text/html,<title>WhyCode Screenshot Test Window</title><body style="background:tomato">Screenshot fixture</body>')
  process.send({ handle: window.getNativeWindowHandle().readBigUInt64LE().toString(), title: window.getTitle() })
  process.on('message', state => {
    if (state === 'background') window.showInactive()
    if (state === 'minimized') window.minimize()
    if (state === 'hidden') window.hide()
    setTimeout(() => process.send({ state }), 350)
  })
})
process.on('disconnect', () => app.quit())
