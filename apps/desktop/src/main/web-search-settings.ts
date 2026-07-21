import type {
  SaveWebSearchSettingsRequest,
  WebSearchSettingsItem,
} from '../shared/settings.ts'
import type { WhycodeConfig } from './config.ts'

const MAX_API_KEY_CHARS = 1_000
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

export function createWebSearchSettingsSnapshot(
  config: WhycodeConfig | null,
): WebSearchSettingsItem {
  return {
    provider: 'perplexity',
    displayName: 'Perplexity Search API',
    hasKey: Boolean(config?.webSearch?.perplexity?.apiKey),
  }
}

export function updateWebSearchSettings(
  config: WhycodeConfig | null,
  request: SaveWebSearchSettingsRequest,
): WhycodeConfig {
  if (request.provider !== 'perplexity') throw new Error('未知的网页搜索服务')
  const next: WhycodeConfig = config ? structuredClone(config) : { providers: {} }
  const suppliedKey = request.apiKey?.trim()
  if (suppliedKey && (
    suppliedKey.length > MAX_API_KEY_CHARS
    || CONTROL_CHARACTER.test(suppliedKey)
  )) throw new Error('Perplexity API key 格式无效')

  const apiKey = request.clearApiKey
    ? ''
    : suppliedKey || next.webSearch?.perplexity?.apiKey || ''
  if (apiKey) {
    next.webSearch = { ...next.webSearch, perplexity: { apiKey } }
  } else {
    delete next.webSearch?.perplexity
    if (next.webSearch && Object.keys(next.webSearch).length === 0) delete next.webSearch
  }
  return next
}
