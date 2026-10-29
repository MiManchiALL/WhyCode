export const WEB_API_TIMEOUT_MS = 20_000
export const WEB_API_MAX_RESPONSE_BYTES = 2_000_000

interface WebJsonRequest {
  endpoint: string
  apiKey: string
  body: Record<string, unknown>
  serviceName: string
  signal: AbortSignal
  statusError: (status: number) => Error
  error: (message: string) => Error
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>
  maxResponseBytes?: number
}

export async function postWebJson(options: WebJsonRequest): Promise<unknown> {
  const response = await (options.fetchImpl ?? fetch)(options.endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(options.body),
    cache: 'no-store',
    credentials: 'omit',
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
    options.maxResponseBytes ?? WEB_API_MAX_RESPONSE_BYTES,
    options.serviceName,
    options.error,
  )
  try {
    return JSON.parse(body) as unknown
  } catch {
    throw options.error(`${options.serviceName}返回了无效 JSON`)
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  serviceName: string,
  error: (message: string) => Error,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw error(`${serviceName}响应超过安全大小限制`)
  }
  if (!response.body) throw error(`${serviceName}返回了空响应`)

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
        throw error(`${serviceName}响应超过安全大小限制`)
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
