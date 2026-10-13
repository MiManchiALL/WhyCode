import type { WebContents } from 'electron'
import { BROWSER_VIEWPORT } from '../shared/browser-agent.ts'

/** 从常驻渲染表面捕获网页，原生读回也受取消与期限约束。 */
export async function captureBrowserPage(guest: WebContents, signal: AbortSignal): Promise<unknown> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)])
  let onAbort: () => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(deadline.reason)
    deadline.addEventListener('abort', onAbort, { once: true })
  })
  try {
    deadline.throwIfAborted()
    const image = await Promise.race([guest.capturePage(undefined, { stayHidden: true }), aborted])
    if (image.isEmpty()) throw new Error('网页画面尚未就绪，请重新观察后截图')
    return { type: 'image', mimeType: 'image/png', data: image.resize({ ...BROWSER_VIEWPORT, quality: 'best' }).toPNG().toString('base64') }
  } finally {
    deadline.removeEventListener('abort', onAbort)
  }
}
