import type {
  ClientRequest,
  ClientRequestConstructorOptions,
  IncomingMessage,
  ResolvedHost,
  ResolveHostOptions,
} from 'electron'
import type { WebPageFetch, WebPageFetchInit } from './network.ts'
import type { WebHostResolver } from './url-safety.ts'

export type ElectronRequestFactory = (
  options: ClientRequestConstructorOptions,
) => ClientRequest
export type ElectronHostResolver = (
  hostname: string,
  options: ResolveHostOptions,
) => Promise<ResolvedHost>

export function createElectronWebHostResolver(
  resolveHost: ElectronHostResolver,
): WebHostResolver {
  return async (hostname) => {
    const results = await Promise.allSettled([
      resolveHost(hostname, { queryType: 'A', cacheUsage: 'allowed' }),
      resolveHost(hostname, { queryType: 'AAAA', cacheUsage: 'allowed' }),
    ])
    const endpoints = results.flatMap((result) =>
      result.status === 'fulfilled' ? result.value.endpoints : [])
    if (endpoints.length === 0) {
      const failure = results.find((result) => result.status === 'rejected')
      throw failure?.reason ?? new Error('域名没有可用地址')
    }
    return { endpoints }
  }
}

/**
 * Electron net.fetch 在 manual 模式遇到重定向会直接拒绝；这里把 net.request 的
 * redirect/response 事件适配成标准 Response，逐跳安全决策仍只保留在 network.ts。
 */
export function createElectronWebPageFetch(
  createRequest: ElectronRequestFactory,
): WebPageFetch {
  return (url, init) => new Promise<Response>((resolve, reject) => {
    if (init.signal?.aborted) {
      reject(init.signal.reason)
      return
    }
    const request = createRequest(requestOptions(url, init))
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanupAbort()
      request.abort()
      reject(init.signal?.reason)
    }
    const cleanupAbort = () => init.signal?.removeEventListener('abort', onAbort)
    const onError = (error: Error) => {
      if (settled) return
      settled = true
      cleanupAbort()
      reject(error)
    }
    request.once('error', onError)
    request.once('close', () => request.removeListener('error', onError))
    init.signal?.addEventListener('abort', onAbort, { once: true })

    request.once('redirect', (statusCode, _method, redirectUrl, responseHeaders) => {
      if (settled) return
      settled = true
      cleanupAbort()
      try {
        const headers = electronHeaders(responseHeaders)
        if (!headers.has('location')) headers.set('location', redirectUrl)
        resolve(new Response(null, { status: statusCode, headers }))
      } catch (error) {
        request.abort()
        reject(error)
      }
    })
    request.once('response', (response) => {
      if (settled) return
      settled = true
      cleanupAbort()
      try {
        resolve(electronResponse(response, request, init.signal ?? null))
      } catch (error) {
        request.abort()
        reject(error)
      }
    })
    request.end()
  })
}

function requestOptions(url: string, init: WebPageFetchInit): ClientRequestConstructorOptions {
  const headers = new Headers(init.headers)
  const electronHeaderValues: Record<string, string> = {}
  headers.forEach((value, name) => { electronHeaderValues[name] = value })
  return {
    url,
    method: init.method ?? 'GET',
    headers: electronHeaderValues,
    redirect: init.redirect ?? 'manual',
    credentials: init.credentials ?? 'omit',
    useSessionCookies: false,
    cache: init.cache,
    referrerPolicy: init.referrerPolicy,
    bypassCustomProtocolHandlers: init.bypassCustomProtocolHandlers ?? true,
  }
}

function electronResponse(
  response: IncomingMessage,
  request: ClientRequest,
  abortSignal: AbortSignal | null,
): Response {
  const headers = electronHeaders(response.headers)
  if ([204, 205, 304].includes(response.statusCode)) {
    return new Response(null, {
      status: response.statusCode,
      statusText: response.statusMessage,
      headers,
    })
  }
  return new Response(electronBody(response, request, abortSignal), {
    status: response.statusCode,
    statusText: response.statusMessage,
    headers,
  })
}

function electronBody(
  response: IncomingMessage,
  request: ClientRequest,
  abortSignal: AbortSignal | null,
): ReadableStream<Uint8Array> {
  let cleanup = () => {}
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let finished = false
      const finish = (error?: Error) => {
        if (finished) return
        finished = true
        cleanup()
        if (error) controller.error(error)
        else controller.close()
      }
      const onData = (chunk: Buffer) => controller.enqueue(Uint8Array.from(chunk))
      const onEnd = () => finish()
      const onError = (error: Error) => finish(error)
      const onAborted = () => finish(new Error('网页响应在完成前中断'))
      const onAbort = () => {
        request.abort()
        finish(abortSignal?.reason instanceof Error ? abortSignal.reason : new Error('网页读取已取消'))
      }
      cleanup = () => {
        response.removeListener('data', onData)
        response.removeListener('end', onEnd)
        response.removeListener('error', onError)
        response.removeListener('aborted', onAborted)
        request.removeListener('error', onError)
        abortSignal?.removeEventListener('abort', onAbort)
      }
      response.on('data', onData)
      response.once('end', onEnd)
      response.once('error', onError)
      response.once('aborted', onAborted)
      request.once('error', onError)
      abortSignal?.addEventListener('abort', onAbort, { once: true })
      if (abortSignal?.aborted) onAbort()
    },
    cancel() {
      cleanup()
      request.abort()
    },
  })
}

function electronHeaders(values: Record<string, string | string[]>): Headers {
  const headers = new Headers()
  for (const [name, rawValue] of Object.entries(values)) {
    for (const value of Array.isArray(rawValue) ? rawValue : [rawValue]) {
      headers.append(name, value)
    }
  }
  return headers
}
