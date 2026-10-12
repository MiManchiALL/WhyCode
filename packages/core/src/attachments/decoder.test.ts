import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { test } from 'node:test'
import sharp from 'sharp'
import { runSharpOperation } from './decoder.ts'

test('取消在途 Sharp Promise 操作只拒绝调用，不发出未捕获流错误', async () => {
  const bytes = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#fd4382' } }).png().toBuffer()
  for (const method of ['metadata', 'stats', 'toBuffer'] as const) {
    const pipeline = sharp(bytes)
    const controller = new AbortController()
    let native: Promise<unknown> | undefined
    const result = runSharpOperation(pipeline, controller.signal, () => {
      native = pipeline[method]()
      return native
    })
    const rejected = assert.rejects(result, /图片处理已取消/)
    controller.abort()
    await rejected
    await native
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  }
})

test('取消后仍接收原生处理迟到的失败，正常解码错误保留原样', async () => {
  const controller = new AbortController()
  let failNative!: (error: Error) => void
  const native = new Promise<never>((_resolve, reject) => { failNative = reject })
  const result = runSharpOperation(sharp(), controller.signal, () => native)
  const rejected = assert.rejects(result, /图片处理已取消/)
  controller.abort()
  await rejected
  failNative(new Error('late native failure'))
  await new Promise(resolve => setImmediate(resolve))
  const invalid = sharp(Buffer.from('invalid image'))
  await assert.rejects(runSharpOperation(invalid, undefined, () => invalid.metadata()), /unsupported image/)
})
