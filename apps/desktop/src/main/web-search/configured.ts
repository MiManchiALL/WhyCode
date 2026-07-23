import type { WebSearchHandler } from '@whycode/core'
import { resolveWebSearchProvider, type WhycodeConfig } from '../config.ts'
import { createPerplexitySearchHandler } from './perplexity.ts'
import { createTavilySearchHandler } from './tavily.ts'

interface ConfiguredWebSearchOptions {
  getConfig: () => WhycodeConfig | null
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>
}

export function createConfiguredWebSearchHandler(
  options: ConfiguredWebSearchOptions,
): WebSearchHandler {
  return (request, abortSignal) => {
    const config = options.getConfig()
    const provider = resolveWebSearchProvider(config)
    const common = {
      getApiKey: () => config?.webSearch?.[provider]?.apiKey,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    }
    return provider === 'tavily'
      ? createTavilySearchHandler({
          ...common,
          searchDepth: config?.webSearch?.tavily?.searchDepth ?? 'basic',
        })(request, abortSignal)
      : createPerplexitySearchHandler(common)(request, abortSignal)
  }
}
