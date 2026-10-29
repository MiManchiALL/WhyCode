import type {
  SaveWebSearchSettingsRequest,
  SaveWebFetchSettingsRequest,
  TavilySearchDepth,
  WebSearchProviderId,
  WebSearchSettingsItem,
} from '../shared/settings.ts'
import {
  resolveWebSearchProvider,
  type WhycodeConfig,
} from './config.ts'

const MAX_API_KEY_CHARS = 1_000
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const TAVILY_SEARCH_DEPTHS = [
  'basic',
  'advanced',
] as const satisfies readonly TavilySearchDepth[]
const WEB_SEARCH_PROVIDERS = [
  { id: 'perplexity', displayName: 'Perplexity Search API' },
  { id: 'tavily', displayName: 'Tavily Search API' },
  { id: 'deepseek', displayName: 'DeepSeek Search API' },
] as const satisfies readonly {
  id: WebSearchProviderId
  displayName: string
}[]

export function createWebSearchSettingsSnapshot(
  config: WhycodeConfig | null,
): WebSearchSettingsItem {
  return {
    activeProvider: resolveWebSearchProvider(config),
    providers: WEB_SEARCH_PROVIDERS.map((provider) => ({
      ...provider,
      hasKey: Boolean(config?.webSearch?.[provider.id]?.apiKey),
      ...(provider.id === 'tavily'
        ? { searchDepth: config?.webSearch?.tavily?.searchDepth ?? 'basic' }
        : {}),
    })),
  }
}

export function updateWebSearchSettings(
  config: WhycodeConfig | null,
  request: SaveWebSearchSettingsRequest,
): WhycodeConfig {
  const provider = WEB_SEARCH_PROVIDERS.find((item) => item.id === request.provider)
  if (!provider) throw new Error('未知的网页搜索服务')
  if (request.provider !== 'tavily' && request.searchDepth !== undefined) {
    throw new Error('只有 Tavily 支持搜索质量档位')
  }
  if (
    request.searchDepth !== undefined
    && !TAVILY_SEARCH_DEPTHS.includes(request.searchDepth)
  ) throw new Error('未知的 Tavily 搜索质量档位')
  const next: WhycodeConfig = config ? structuredClone(config) : { providers: {} }
  const previousActive = resolveWebSearchProvider(next)
  const suppliedKey = request.apiKey?.trim()
  if (suppliedKey && (
    suppliedKey.length > MAX_API_KEY_CHARS
    || CONTROL_CHARACTER.test(suppliedKey)
  )) throw new Error(`${provider.displayName} key 格式无效`)

  const apiKey = request.clearApiKey
    ? ''
    : suppliedKey || next.webSearch?.[request.provider]?.apiKey || ''
  const webSearch = next.webSearch ?? {}
  if (apiKey) {
    if (request.provider === 'tavily') {
      webSearch.tavily = {
        apiKey,
        searchDepth: request.searchDepth
          ?? webSearch.tavily?.searchDepth
          ?? 'basic',
      }
    } else {
      webSearch[request.provider] = { apiKey }
    }
  } else {
    delete webSearch[request.provider]
  }

  const configured = WEB_SEARCH_PROVIDERS
    .map((item) => item.id)
    .filter((id) => Boolean(webSearch[id]?.apiKey))
  if (request.setActive && !apiKey) {
    throw new Error(`请先配置 ${provider.displayName} key`)
  }
  if (configured.length === 0) {
    delete next.webSearch
  } else {
    webSearch.activeProvider = request.setActive
      ? request.provider
      : configured.includes(previousActive)
        ? previousActive
        : configured[0]!
    next.webSearch = webSearch
  }
  return next
}

export function updateWebFetchSettings(
  config: WhycodeConfig | null,
  request: SaveWebFetchSettingsRequest,
): WhycodeConfig {
  if (request?.provider !== 'builtin' && request?.provider !== 'deepseek') {
    throw new Error('未知的网页抓取服务')
  }
  if (request.provider === 'deepseek' && !config?.webSearch?.deepseek?.apiKey) {
    throw new Error('请先配置上方的 DeepSeek API Key，搜索与抓取共用此密钥')
  }
  const next: WhycodeConfig = config ? structuredClone(config) : { providers: {} }
  next.webFetch = { provider: request.provider }
  return next
}
