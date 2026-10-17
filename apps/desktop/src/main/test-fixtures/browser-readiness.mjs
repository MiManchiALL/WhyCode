import assert from 'node:assert/strict'
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { nativeImage } from 'electron'
import { browserHasVisibleContent } from '../browser-visibility.ts'

/** 用独立网页验证内容判定，不依赖站点选择器、网络响应或模型输出。 */
export async function checkBrowserReadiness({ directory, run, finish, agent, guests }) {
  const file = path.join(directory, 'readiness.html')
  await writeFile(file, '<!doctype html><title>Readiness</title><body style="margin:0;background:white">')
  assert.equal((await run('readiness', `await browser.open({url:${JSON.stringify(pathToFileURL(file).href)}});`)).isError, false)
  const guest = guests.get(agent.pages.current('readiness').surfaceId)
  assert.equal(await guest.executeJavaScript('document.readyState'), 'complete')
  assert.equal(await guest.executeJavaScript(browserHasVisibleContent), false, '文档加载完成不代表已有页面内容')
  await guest.executeJavaScript(`document.body.innerHTML='<div style="display:none">Hidden</div><div style="opacity:0">Transparent</div><div style="position:absolute;top:1600px">Offscreen</div><script>"Script source"<\/script>'`)
  assert.equal(await guest.executeJavaScript(browserHasVisibleContent), false, '隐藏文字和脚本源码不能解除空白等待')
  await guest.executeJavaScript(`document.body.innerHTML='<canvas width="1280" height="800"></canvas>'; const ctx=document.querySelector('canvas').getContext('2d'); ctx.fillStyle='rgb(100,150,200)';ctx.fillRect(0,0,1280,800);`)
  assert.equal(await guest.executeJavaScript(browserHasVisibleContent), true, '没有可访问文字的画布也有可见内容')
  const canvas = await run('readiness', 'image(await browser.screenshot());')
  assert.equal(canvas.isError, false, canvas.text)
  assert.deepEqual([...nativeImage.createFromBuffer(canvas.images[0].bytes).toBitmap().subarray(0, 3)], [200, 150, 100])
  await guest.executeJavaScript(`document.body.innerHTML='<div style="display:contents"><button>Loaded content</button></div>'`)
  const content = await run('readiness', 'text(await browser.snapshot()); image(await browser.screenshot());')
  assert.equal(content.isError, false, content.text)
  assert.match(content.text, /Loaded content/)
  assert.equal(content.images.length, 1)
  await finish('readiness')
  assert.equal(guest.isDestroyed(), true)
}
