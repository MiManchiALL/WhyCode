import { WebSearchError } from '@whycode/core'

export const SEARCH_REQUEST_TIMEOUT_MS = 20_000
export const SEARCH_MAX_RESPONSE_BYTES = 2_000_000

interface SearchJsonRequest {
  endpoint: string
  apiKey: string
  body: Record<string, unknown>
  serviceName: string
  signal: AbortSignal
  statusError: (status: number) => WebSearchError
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>
  maxResponseBytes?: number
}

export async function postSearchJson(options: SearchJsonRequest): Promise<unknown> {
  const response = await (options.fetchImpl ?? fetch)(options.endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(options.body),
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal: options.signal,
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw options.statusError(response.status)
  }

  const body = await readBoundedResponse(
    response,
    options.maxResponseBytes ?? SEARCH_MAX_RESPONSE_BYTES,
    options.serviceName,
  )
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new WebSearchError(`${options.serviceName}返回了无效 JSON`)
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  serviceName: string,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new WebSearchError(`${serviceName}响应超过安全大小限制`)
  }
  if (!response.body) throw new WebSearchError(`${serviceName}返回了空响应`)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        throw new WebSearchError(`${serviceName}响应超过安全大小限制`)
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}
