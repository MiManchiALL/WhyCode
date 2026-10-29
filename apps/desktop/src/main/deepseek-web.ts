import { WEB_API_TIMEOUT_MS, postWebJson } from './web-http.ts'

export interface DeepSeekWebOptions {
  getApiKey: () => string | undefined
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>
  timeoutMs?: number
}

/** 固定官方端点；模型连接的自定义地址和密钥不会流入网页服务。 */
export async function requestDeepSeekWeb(
  options: DeepSeekWebOptions,
  operation: 'search' | 'fetch',
  body: Record<string, unknown>,
  abortSignal: AbortSignal,
  ErrorType: new (message: string) => Error,
  maxResponseBytes?: number,
): Promise<unknown> {
  const label = operation === 'search' ? '搜索' : '抓取'
  const apiKey = options.getApiKey()?.trim()
  if (!apiKey) throw new ErrorType('尚未配置 DeepSeek API Key，请在“设置 → 网页搜索与抓取”中配置')
  const timeout = AbortSignal.timeout(options.timeoutMs ?? WEB_API_TIMEOUT_MS)
  const signal = AbortSignal.any([abortSignal, timeout])
  try {
    signal.throwIfAborted()
    return await postWebJson({
      endpoint: `https://api.deepseek.com/v1/tools/${operation}`,
      apiKey,
      body,
      serviceName: `DeepSeek 网页${label}`,
      signal,
      error: (message) => new ErrorType(message),
      statusError: (status) => new ErrorType(statusMessage(status, label)),
      fetchImpl: options.fetchImpl,
      maxResponseBytes,
    })
  } catch (cause) {
    if (abortSignal.aborted) throw new ErrorType(`网页${label}已取消`)
    if (timeout.aborted) throw new ErrorType(`DeepSeek 网页${label}请求超时，请稍后重试`)
    // 仅放行本边界创建的已脱敏错误，不回传上游正文或网络异常中的凭据。
    if (cause instanceof ErrorType) throw cause
    throw new ErrorType(`无法连接 DeepSeek 网页${label}服务`)
  }
}

function statusMessage(status: number, label: string): string {
  if (status === 401) return 'DeepSeek API Key 无效，请在“设置 → 网页搜索与抓取”中更新'
  if (status === 402) return 'DeepSeek 账户余额不足，请充值后重试'
  if (status === 403) return `DeepSeek 拒绝了网页${label}请求（安全策略或权限限制）`
  if (status === 404 && label === '抓取') return 'DeepSeek 未能获取可用正文；可检查网址，或在设置中切换为内置抓取'
  if (status === 429) return `DeepSeek 网页${label}请求过于频繁，请稍后重试`
  if (status === 408 || status === 504) return `DeepSeek 网页${label}请求超时，请稍后重试`
  if (status >= 500) return `DeepSeek 网页${label}服务暂时不可用，请稍后重试`
  return `DeepSeek 网页${label}请求失败（HTTP ${status}）`
}
