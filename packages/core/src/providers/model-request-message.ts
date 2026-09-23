import { APICallError } from 'ai'

/** 只读取错误字段，不能把供应商的响应正文、请求参数或调试信息当成展示原因。 */
export function modelRequestDetail(error: unknown): string {
  if (APICallError.isInstance(error)) {
    return errorDetail(error.data)
      ?? errorDetail(parseJson(error.responseBody))
      ?? errorDetail(parseJson(error.message))
      ?? error.message
  }
  if (error instanceof Error) return errorDetail(parseJson(error.message)) ?? error.message
  return errorDetail(error) ?? '模型请求失败'
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined
  try { return JSON.parse(value) } catch { return undefined }
}

function errorDetail(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined
  if (typeof value === 'string') {
    const parsed = parseJson(value)
    return parsed === undefined ? (value.trim() || undefined) : errorDetail(parsed, depth + 1)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  const message = errorDetail(fields.error, depth + 1)
    ?? errorDetail(fields.message, depth + 1)
    ?? (typeof fields.detail === 'string' ? fields.detail : undefined)
  const code = typeof fields.code === 'string' ? fields.code
    : typeof fields.type === 'string' && fields.type !== 'error' ? fields.type : undefined
  return code && !message?.includes(code) ? `${code}${message ? `: ${message}` : ''}` : message
}

export function modelRequestMessage(detail: string, status?: number, requestId?: string | null): string {
  let reason = detail.trim()
  const structured = parseJson(reason)
  // 错误页不是可交付文本；不逐标签剥离，否则 CSS、脚本和导航仍会混入原因。
  if (!reason || /<!doctype\s+html|<\/?(?:html|head|body|title|style|script|h1|p|div|pre)(?:\s|>)/iu.test(reason)
    || (structured !== null && typeof structured === 'object')) {
    reason = statusReason(status)
  } else if (/\bauth_unavailable\b/iu.test(reason)) {
    reason = '上游服务暂无可用的认证凭据（auth_unavailable）'
  }
  const id = requestId ? conciseText(requestId, 128) : ''
  return `${conciseText(reason, 240)}${status === undefined ? '' : `（HTTP ${status}）`}${id ? `；请求 ID：${id}` : ''}`
}

function conciseText(value: string, limit: number): string {
  const text = value.replace(/\s+/gu, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function statusReason(status: number | undefined): string {
  switch (status) {
    case 400: return '模型服务拒绝了请求参数'
    case 401: return '模型服务认证失败'
    case 402: return '模型服务要求付费'
    case 403: return '模型服务拒绝访问'
    case 404: return '模型服务未找到请求的资源'
    case 408: return '模型服务请求超时'
    case 413: return '模型请求内容过大'
    case 429: return '模型服务请求过于频繁'
    case 502: return '上游服务暂时异常'
    case 503: return '上游服务暂时不可用'
    case 504: return '上游服务响应超时'
    default: return status !== undefined && status >= 500 ? '模型服务暂时异常' : '模型服务返回了异常响应'
  }
}
