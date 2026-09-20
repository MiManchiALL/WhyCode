export const SITE_ICON_SCHEME = 'whycode-site-icon'

export function siteIconUrl(origin: string): string {
  return `${SITE_ICON_SCHEME}://icon/?origin=${encodeURIComponent(origin)}`
}
