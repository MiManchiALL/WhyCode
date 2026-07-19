import ipaddr from 'ipaddr.js'
import { WEB_PAGE_MAX_URL_CHARS, WebPageError } from '@whycode/core'

export interface ResolvedWebHost {
  endpoints: readonly { address: string }[]
}

export type WebHostResolver = (hostname: string) => Promise<ResolvedWebHost>

const NON_PUBLIC_HOST_SUFFIXES = [
  '.internal',
  '.home.arpa',
  '.invalid',
  '.lan',
  '.local',
  '.localhost',
  '.onion',
  '.test',
]
const PLATFORM_SERVICE_ADDRESSES = new Set(['168.63.129.16'])

export function parseWebPageUrl(value: string): URL {
  if (value.length > WEB_PAGE_MAX_URL_CHARS) throw new WebPageError('网页地址无效')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new WebPageError('网页地址无效')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new WebPageError('网页读取只支持不含账号密码的 HTTP/HTTPS 地址')
  }
  url.hash = ''
  if (url.toString().length > WEB_PAGE_MAX_URL_CHARS) throw new WebPageError('网页地址无效')
  return url
}

export async function assertPublicWebTarget(
  url: URL,
  resolveHost: WebHostResolver,
  abortSignal?: AbortSignal,
): Promise<void> {
  const hostname = unbracketedHostname(url.hostname).toLowerCase().replace(/\.$/u, '')
  if (!hostname || hostname === 'localhost' || NON_PUBLIC_HOST_SUFFIXES.some((suffix) =>
    hostname.endsWith(suffix))) {
    throw blockedTargetError()
  }

  if (ipaddr.isValid(hostname)) {
    if (!isPublicAddress(hostname)) throw blockedTargetError()
    return
  }
  // 单标签主机名只在本机或内网 DNS 中有意义；网页读取不应探测它们。
  if (!hostname.includes('.')) throw blockedTargetError()

  let resolved: ResolvedWebHost
  try {
    resolved = await waitForResolution(resolveHost(hostname), abortSignal)
  } catch {
    if (abortSignal?.aborted) throw abortSignal.reason
    throw new WebPageError('无法解析目标网站地址')
  }
  if (
    !Array.isArray(resolved.endpoints)
    || resolved.endpoints.length === 0
    || resolved.endpoints.some((endpoint) => !isPublicAddress(endpoint.address))
  ) throw blockedTargetError()
}

function waitForResolution<T>(promise: Promise<T>, abortSignal?: AbortSignal): Promise<T> {
  if (!abortSignal) return promise
  if (abortSignal.aborted) return Promise.reject(abortSignal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortSignal.reason)
    }
    const cleanup = () => abortSignal.removeEventListener('abort', onAbort)
    abortSignal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function isPublicAddress(value: string): boolean {
  try {
    const address = ipaddr.parse(unbracketedHostname(value))
    return address.range() === 'unicast' && !PLATFORM_SERVICE_ADDRESSES.has(address.toString())
  } catch {
    return false
  }
}

function unbracketedHostname(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

function blockedTargetError(): WebPageError {
  return new WebPageError('出于安全原因，网页读取不能访问本机、内网或保留地址')
}
