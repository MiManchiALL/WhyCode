import type { CliProxyApiConfig } from './config.ts'
import { resolveCliProxyRoutes } from './cli-proxy-models.ts'

type FetchImplementation = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

const DISCOVERY_TIMEOUT_MS = 3_000
const MAX_RESPONSE_BYTES = 2_000_000
const MAX_MODEL_COUNT = 10_000
const MAX_MODEL_ID_LENGTH = 300

export async function discoverCliProxyRoutes(
  connection: Pick<CliProxyApiConfig, 'apiKey' | 'baseURL' | 'modelIds'>,
  fetchImpl: FetchImplementation,
): Promise<Record<string, string>> {
  const response = await fetchImpl(modelsEndpoint(connection.baseURL), {
    method: 'GET',
    headers: { Authorization: `Bearer ${connection.apiKey}` },
    redirect: 'error',
    cache: 'no-store',
    credentials: 'omit',
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`CLIProxyAPI 模型目录请求失败（HTTP ${response.status}）`)
  }

  const responseText = await readBoundedResponse(response)
  let payload: unknown
  try {
    payload = JSON.parse(responseText) as unknown
  } catch {
    throw new Error('CLIProxyAPI /models 返回了无效 JSON')
  }
  const advertisedModelIds = parseModelIds(payload)
  return resolveCliProxyRoutes(connection.modelIds, advertisedModelIds)
}

export function unresolvedCliProxyProfiles(
  modelIds: readonly string[],
  routes: Readonly<Record<string, string>>,
): string[] {
  return modelIds.filter((modelId) => !routes[modelId])
}

function modelsEndpoint(baseURL: string): string {
  return `${baseURL.replace(/\/+$/u, '')}/models`
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw new Error('CLIProxyAPI /models 响应超过安全大小限制')
  }
  if (!response.body) throw new Error('CLIProxyAPI /models 返回了空响应')

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('CLIProxyAPI /models 响应超过安全大小限制')
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

function parseModelIds(payload: unknown): Set<string> {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('CLIProxyAPI /models 返回格式不正确')
  }
  if (payload.data.length > MAX_MODEL_COUNT) {
    throw new Error('CLIProxyAPI /models 返回的型号数量异常')
  }
  const modelIds = new Set<string>()
  for (const item of payload.data) {
    if (!isRecord(item) || typeof item.id !== 'string') continue
    const id = item.id.trim()
    if (id && id.length <= MAX_MODEL_ID_LENGTH) modelIds.add(id)
  }
  return modelIds
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
