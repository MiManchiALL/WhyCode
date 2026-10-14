import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NativeImage, WebContents } from 'electron'
import { captureBrowserPage } from './browser-capture.ts'

for (const lateFailure of [false, true]) test(`取消截图后限制在途读回，迟到${lateFailure ? '失败' : '成功'}后可再次捕获`, async () => {
  let complete!: (value: NativeImage) => void
  let fail!: (reason: Error) => void
  const native = new Promise<NativeImage>((resolve, reject) => { complete = resolve; fail = reject })
  const image = { isEmpty: () => false, resize() { return this }, toPNG: () => Buffer.from('image') } as unknown as NativeImage
  let calls = 0
  const guest = { capturePage: () => ++calls === 1 ? native : Promise.resolve(image) } as unknown as WebContents
  const controller = new AbortController()
  const pending = captureBrowserPage(guest, controller.signal)
  const stopped = new Error('user_closed: 用户停止了 Agent 网页')
  controller.abort(stopped)
  await assert.rejects(pending, error => error === stopped)
  await assert.rejects(captureBrowserPage(guest, new AbortController().signal), /上一次网页截图仍未完成/)
  assert.equal(calls, 1, '取消等待不代表原生读回已结束，不能叠加请求')

  if (lateFailure) fail(new Error('原生读回失败'))
  else complete(image)
  await Promise.resolve()
  assert.deepEqual(await captureBrowserPage(guest, new AbortController().signal), {
    type: 'image', mimeType: 'image/png', data: Buffer.from('image').toString('base64'),
  })
  await assert.rejects(captureBrowserPage(guest, controller.signal), error => error === stopped)
  assert.equal(calls, 2, '已取消的调用不会开始新捕获')
})
