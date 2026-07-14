import { protocol } from 'electron'
import { readStoredImage, type SessionJournal } from '@whycode/core'

const ATTACHMENT_SCHEME = 'whycode-attachment'

/** 自定义 scheme 必须在 Electron ready 前注册权限。 */
export function registerAttachmentScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: ATTACHMENT_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  }])
}

/** 只向 Renderer 暴露当前会话的严格附件名，不提供任意本地文件读取。 */
export function registerAttachmentProtocol(
  currentJournal: () => SessionJournal | null,
): void {
  protocol.handle(ATTACHMENT_SCHEME, async (request) => {
    if (request.method !== 'GET') return new Response(null, { status: 405 })
    try {
      const url = new URL(request.url)
      const sessionId = url.hostname
      const storageName = decodeURIComponent(url.pathname.slice(1))
      const journal = currentJournal()
      if (!journal || journal.sessionId !== sessionId || storageName.includes('/')) {
        return new Response(null, { status: 404 })
      }
      const stored = await readStoredImage(journal.attachmentDirectory, storageName)
      return new Response(Uint8Array.from(stored.bytes), {
        status: 200,
        headers: {
          // 会话删除必须清除全部图片字节，不能在 Chromium 磁盘缓存留下副本。
          'Cache-Control': 'no-store',
          'Content-Type': stored.mediaType,
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}
