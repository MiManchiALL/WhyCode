import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import path from 'node:path'
import { promisify } from 'node:util'
import { BrowserWindow, session } from 'electron'

async function certificate(directory, index) {
  if (process.platform === 'win32') {
    // 只在内存生成测试证书，不写 Windows 证书库或提交固定私钥。
    const script = `$ErrorActionPreference='Stop'
      $key=[System.Security.Cryptography.RSA]::Create(2048)
      $request=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=whycode-browser.test',$key,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
      $cert=$request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddDays(-1),[DateTimeOffset]::UtcNow.AddDays(2))
      [Convert]::ToBase64String($cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,''))
      $cert.Dispose(); $key.Dispose()`
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15_000 })
    return { pfx: Buffer.from(stdout.trim(), 'base64'), passphrase: '' }
  }
  const key = path.join(directory, `certificate-${index}.key`), cert = path.join(directory, `certificate-${index}.pem`)
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=whycode-browser.test'], { timeout: 15_000 })
  return { key: await readFile(key), cert: await readFile(cert) }
}

export async function checkBrowserCertificates({ directory, execute, until, agent, guests, run, finish, win }) {
  const first = await certificate(directory, 0), replacement = await certificate(directory, 1)
  let requests = 0
  const server = createServer(first, (request, response) => {
    requests++
    response.setHeader('Cache-Control', 'no-store')
    if (request.url === '/asset.js') {
      response.setHeader('Content-Type', 'text/javascript')
      response.end('document.body.dataset.asset="loaded"; fetch("/data").then(r=>r.text()).then(text=>document.body.dataset.data=text); const socket=new WebSocket(location.origin.replace("https:","wss:")); socket.onopen=()=>document.body.dataset.socket="opened";')
    } else if (request.url === '/data') response.end('loaded')
    else response.end('<!doctype html><title>Certificate fixture</title><h1>Certificate page loaded</h1><script src="/asset.js"></script>')
  })
  const sockets = new Set()
  server.on('upgrade', (request, socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  })
  const other = createServer(first, (_request, response) => response.end('<h1>Other origin</h1>'))
  await Promise.all([server, other].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))))
  const url = `https://127.0.0.1:${server.address().port}/`, otherUrl = `https://127.0.0.1:${other.address().port}/`
  const browserSession = session.fromPartition('persist:whycode-browser')
  let outsider
  const trust = (id, token) => execute(`window.whycode.trustBrowserCertificate(${JSON.stringify(id)},${JSON.stringify(token)})`)
  const issue = () => execute('window.certificateEvents.filter(event=>event.certificate).at(-1)')
  const warning = () => execute('!!document.querySelector(\'[role="alert"] details\')')
  const accept = async () => {
    await execute('document.querySelector(\'[role="alert"] summary\').click()')
    await execute('Array.from(document.querySelectorAll(\'[role="alert"] button\')).find(button=>button.textContent==="继续访问（不安全）").click()')
  }
  try {
    await execute('fixture.session("alpha"); window.certificateEvents=[]; window.stopCertificateEvents=window.whycode.onBrowserEvent(event=>{if(event.type==="certificate")window.certificateEvents.push(event)}); undefined')
    await execute(`fixture.open(${JSON.stringify(url)})`)
    await until(warning, 'certificate error page')
    const blocked = await issue()
    const guest = guests.get(blocked.id)
    assert.equal(requests, 0, '未确认前不向站点发送 HTTP 请求')
    assert.equal(await execute('document.querySelector(\'[role="alert"] details\').open'), false, '先展示错误，用户主动展开高级选项')
    assert.match(blocked.certificate.error, /ERR_CERT_(AUTHORITY|COMMON_NAME)_INVALID/)
    assert.equal(blocked.certificate.subjectName, 'whycode-browser.test')
    assert.match(blocked.certificate.fingerprint, /^([A-F0-9]{2}:){31}[A-F0-9]{2}$/)
    await assert.rejects(trust(blocked.id, 'invented'), /证书确认已失效/)

    outsider = new BrowserWindow({ show: false, webPreferences: { preload: path.join(directory, 'preload.cjs') } })
    await outsider.loadURL('about:blank')
    await assert.rejects(outsider.webContents.executeJavaScript(`window.whycode.trustBrowserCertificate(${JSON.stringify(blocked.id)},${JSON.stringify(blocked.certificate.id)})`), /证书确认已失效/)
    await guests.navigate(blocked.id, 'about:blank')
    await assert.rejects(trust(blocked.id, blocked.certificate.id), /证书确认已失效/, '导航后旧确认失效')
    await assert.rejects(guests.navigate(blocked.id, url), /ERR_CERT_/)
    await until(warning, 'new certificate challenge')
    const current = await issue()
    assert.notEqual(current.certificate.id, blocked.certificate.id)
    await execute('document.querySelector(\'[role="alert"] summary\').click(); fixture.narrow()')
    await until(() => execute('document.querySelector(\'[aria-label="内置浏览器"]\').getBoundingClientRect().width===300'), 'narrow certificate error')
    assert.equal(await execute('(() => {const alert=document.querySelector(\'[role="alert"]\');return alert.scrollWidth<=alert.clientWidth})()'), true, '证书长指纹不撑破窄栏')
    if (process.env.WHYCODE_BROWSER_REVIEW_DIR) {
      await mkdir(process.env.WHYCODE_BROWSER_REVIEW_DIR, { recursive: true })
      await writeFile(path.join(process.env.WHYCODE_BROWSER_REVIEW_DIR, 'certificate.png'), (await win.webContents.capturePage()).toPNG())
    }
    await execute('document.querySelector(\'[role="alert"] summary\').click()')
    await accept()
    await until(() => guest.executeJavaScript('document.body.dataset.asset==="loaded" && document.body.dataset.data==="loaded" && document.body.dataset.socket==="opened"'), 'confirmed page, subresources and WebSocket')
    assert.equal(await warning(), false)
    await assert.rejects(outsider.loadURL(url), /ERR_CERT_/, '证书例外不影响主页面分区')
    outsider.destroy(); outsider = undefined
    await guests.navigate(current.id, url + 'next')
    assert.equal(guest.getTitle(), 'Certificate fixture', '同站点导航复用本次允许')
    await assert.rejects(guests.navigate(current.id, otherUrl), /ERR_CERT_/, '相同证书的另一个端口仍需确认')
    await until(warning, 'other origin remains blocked')
    const beforeClose = await issue()
    await execute('fixture.session("alpha"); fixture.narrow(420)')
    await until(() => !guests.get(current.id), 'closed certificate page')
    await assert.rejects(trust(beforeClose.id, beforeClose.certificate.id), /证书确认已失效/, '关闭标签撤销待确认记录')

    const denied = await run('certificate-agent', `await browser.open({url:${JSON.stringify(otherUrl)}});`)
    assert.equal(denied.isError, true, 'Agent 不能自行放行未确认站点')
    assert.match(denied.text, /ERR_CERT_/)
    const allowed = await run('certificate-agent', `await browser.navigate({url:${JSON.stringify(url)}}); text(await browser.evaluate({expression:"document.title"}));`)
    assert.equal(allowed.isError, false, allowed.text)
    assert.match(allowed.text, /Certificate fixture/, 'Agent 可使用用户已明确允许的站点')
    await execute('fixture.visible(false)')
    await finish('certificate-agent')
    for (const socket of sockets) socket.destroy()
    await browserSession.closeAllConnections()
    server.setSecureContext(replacement)
    await execute(`fixture.open(${JSON.stringify(url)})`)
    await until(warning, 'replacement certificate requires confirmation')
    const changed = await issue()
    assert.notEqual(changed.certificate.fingerprint, current.certificate.fingerprint)
    await accept()
    const changedGuest = guests.get(changed.id)
    await until(() => changedGuest.getTitle() === 'Certificate fixture', 'replacement accepted')
    await execute('window.whycode.clearBrowserData("cache")')
    await guests.navigate(changed.id, url)
    assert.equal(changedGuest.getTitle(), 'Certificate fixture', '清理缓存保留本次证书允许')
    await execute('window.whycode.clearBrowserData("all")')
    assert.equal(changedGuest.isDestroyed(), true)
    await execute('fixture.session("alpha")')
    await execute(`fixture.open(${JSON.stringify(url)})`)
    await until(warning, 'all data clearing revokes certificate exceptions')
  } finally {
    outsider?.destroy()
    await finish('certificate-agent')
    await execute('window.stopCertificateEvents(); window.whycode.clearBrowserData("all")')
    await execute('fixture.session("alpha")')
    for (const socket of sockets) socket.destroy()
    await Promise.all([server, other].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) })))
  }
}
