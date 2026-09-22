import { protocol } from 'electron'
import { PREVIEW_SCHEME } from '../shared/workspace-files.ts'
import { SITE_ICON_SCHEME } from '../shared/site-icon.ts'
import { readStoredImage } from '@whycode/core'

const ATTACHMENT_SCHEME = 'whycode-attachment'

/** 自定义 scheme 必须在 Electron ready 前注册权限。 */
export function registerFileSchemes(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: ATTACHMENT_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  }, {
    scheme: PREVIEW_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  }, {
    scheme: SITE_ICON_SCHEME,
    privileges: { standard: true, secure: true },
  }])
}

/** 只暴露宿主确认归属的会话附件目录，不提供任意本地文件读取。 */
export function registerAttachmentProtocol(
  directoryForSession: (sessionId: string) => Promise<string | null>,
): void {
  protocol.handle(ATTACHMENT_SCHEME, async (request) => {
    if (request.method !== 'GET') return new Response(null, { status: 405 })
    try {
      const url = new URL(request.url)
      const sessionId = url.hostname
      const storageName = decodeURIComponent(url.pathname.slice(1))
      const directory = await directoryForSession(sessionId)
      if (!directory || storageName.includes('/')) {
        return new Response(null, { status: 404 })
      }
      const stored = await readStoredImage(directory, storageName)
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
