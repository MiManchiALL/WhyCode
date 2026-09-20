import { fetchPublicWebResponse, readBoundedBody, type WebDocumentFetcherOptions } from './web-page/network.ts'
import { parseWebPageUrl } from './web-page/url-safety.ts'

const MAX_ICON_BYTES = 64 * 1024
const MAX_CACHED_ICONS = 64
const ICON_TYPES = new Set(['image/x-icon', 'image/vnd.microsoft.icon', 'image/png', 'image/svg+xml', 'image/jpeg', 'image/gif', 'image/webp'])

interface SiteIcon {
  bytes: Uint8Array | null
  contentType: string
  expiresAt: number
}

export function createSiteIconHandler(options: WebDocumentFetcherOptions) {
  // 自定义协议不能可靠依赖 Chromium 跨挂载缓存；只保留最近 64 个站点，图片字节最多 4 MiB。
  const cache = new Map<string, SiteIcon>()
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') return new Response(null, { status: 405 })
    let target: URL
    try {
      const origin = new URL(request.url).searchParams.get('origin') ?? ''
      target = parseWebPageUrl(origin)
      if (origin !== target.origin) return new Response(null, { status: 400 })
    } catch {
      return new Response(null, { status: 400 })
    }
    const cached = cache.get(target.origin)
    cache.delete(target.origin)
    if (cached && cached.expiresAt > Date.now()) {
      cache.set(target.origin, cached)
      return iconResponse(cached)
    }
    let icon: SiteIcon
    try {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)])
      const { response } = await fetchPublicWebResponse(new URL('/favicon.ico', target), options, signal, 'image/*')
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
      if (!ICON_TYPES.has(contentType)) {
        await response.body?.cancel()
        icon = missingIcon()
      } else {
        icon = { bytes: await readBoundedBody(response, MAX_ICON_BYTES), contentType, expiresAt: Date.now() + 86_400_000 }
      }
    } catch {
      // 网站缺少图标、离线与取消只影响装饰，不能阻断正文或弹出错误提醒。
      icon = missingIcon()
    }
    if (!request.signal.aborted) {
      cache.delete(target.origin)
      cache.set(target.origin, icon)
      if (cache.size > MAX_CACHED_ICONS) cache.delete(cache.keys().next().value!)
    }
    return iconResponse(icon)
  }
}

function missingIcon(): SiteIcon {
  return { bytes: null, contentType: '', expiresAt: Date.now() + 300_000 }
}

function iconResponse(icon: SiteIcon): Response {
  return new Response(icon.bytes ? Uint8Array.from(icon.bytes) : null, {
    status: icon.bytes ? 200 : 404,
    headers: {
      ...(icon.bytes ? { 'Content-Type': icon.contentType } : {}),
      'Cache-Control': `public, max-age=${Math.max(0, Math.floor((icon.expiresAt - Date.now()) / 1000))}`,
      'Content-Security-Policy': "default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
