import type { WebContents } from 'electron'

const pendingCaptures = new WeakSet<WebContents>()

/** 从常驻渲染表面捕获网页，原生读回也受取消与期限约束。 */
export async function captureBrowserPage(guest: WebContents, signal: AbortSignal, viewport: { width: number; height: number }): Promise<unknown> {
  signal.throwIfAborted()
  if (pendingCaptures.has(guest)) throw new Error('上一次网页截图仍未完成，请勿重复请求')
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.aborted ? signal.reason : new Error('网页截图等待绘制超时'))
    deadline.addEventListener('abort', onAbort, { once: true })
  })
  try {
    deadline.throwIfAborted()
    // 默认的 capturer 生命周期唤醒页面绘制，不显示 BrowserWindow 或改变用户焦点。
    const capture = guest.capturePage()
    pendingCaptures.add(guest)
    void capture.then(() => pendingCaptures.delete(guest), () => pendingCaptures.delete(guest))
    const image = await Promise.race([capture, aborted])
    if (image.isEmpty()) throw new Error('网页画面尚未就绪，请重新观察后截图')
    return { type: 'image', mimeType: 'image/png', data: image.resize({ ...viewport, quality: 'best' }).toPNG().toString('base64') }
  } finally {
    deadline.removeEventListener('abort', onAbort)
  }
}
