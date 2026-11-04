import { createHash } from 'node:crypto'

export type DiagnosticLevel = 'info' | 'warn' | 'error'
export interface DiagnosticEvent {
  level: DiagnosticLevel
  source: string
  event: string
  details?: Record<string, unknown>
}

const SECRET_KEY = /password|passwd|secret|authorization|cookie|credential|api.?key|token|private.?key/i
const PAYLOAD_KEY = /^(messages|prompt|input|output|body|request|response|headers|content)$/i
export const MAX_RECORD_BYTES = 64 * 1024

export function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value.slice(0, maxBytes))
  if (bytes.length <= maxBytes) return bytes.toString()
  let end = maxBytes
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end).toString()
}

export function diagnosticText(value: string, maxBytes = 16 * 1024): string {
  // 先限制工作量，再处理 URL 与常见凭据字段；调用方只传诊断元数据，不传消息/请求正文。
  const bounded = utf8Prefix(value, maxBytes)
  const clean = bounded
    .replace(/\b(?:https?|wss?|file):\/\/[^\s<>"']+/gi, text => {
      try {
        const url = new URL(text)
        url.username = ''; url.password = ''; url.search = ''; url.hash = ''
        return url.toString()
      } catch { return '[redacted-url]' }
    })
    .replace(/["']?\b(?:authorization|proxy-authorization|set-cookie|cookie)["']?\s*:\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/gi, '[redacted-header]')
    .replace(/(["']?(?:password|passwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\bBearer\s+[\w.+/=-]+/gi, 'Bearer [redacted]')
  return clean + (bounded.length < value.length ? '…[truncated]' : '')
}

function sanitize(value: unknown, budget: { remaining: number }, depth = 0): unknown {
  if (budget.remaining < 64 || depth > 5) return '[truncated]'
  // 对纯数字/布尔值的宽树也计入预算，不能只限制字符串而留下无界节点分配。
  budget.remaining -= 64
  if (typeof value === 'string') {
    const text = diagnosticText(value, Math.min(16 * 1024, budget.remaining))
    budget.remaining -= Buffer.byteLength(text)
    return text
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Error) return sanitize({
    name: value.name, message: value.message, stack: value.stack, cause: value.cause,
  }, budget, depth + 1)
  if (Array.isArray(value)) return value.slice(0, 32).map(item => sanitize(item, budget, depth + 1))
  if (typeof value !== 'object') return undefined
  const result: Record<string, unknown> = {}
  let count = 0
  for (const key in value) {
    if (++count > 32 || budget.remaining <= 0) { result.truncated = true; break }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor)) continue
    result[diagnosticText(key, 128)] = SECRET_KEY.test(key) ? '[redacted]'
      : PAYLOAD_KEY.test(key) ? '[omitted]' : sanitize(descriptor.value, budget, depth + 1)
  }
  return result
}

export function formatDiagnostic(event: DiagnosticEvent, time: number, runId: string): string {
  const record = {
    time: new Date(time).toISOString(), runId, pid: process.pid,
    level: event.level, source: diagnosticText(event.source, 128), event: diagnosticText(event.event, 128),
    details: sanitize(event.details, { remaining: 32 * 1024 }),
  }
  const line = JSON.stringify(record) + '\n'
  if (Buffer.byteLength(line) <= MAX_RECORD_BYTES) return line
  return JSON.stringify({ ...record, details: {
    truncated: true, preview: utf8Prefix(JSON.stringify(record.details), 8 * 1024),
  } }) + '\n'
}

export function diagnosticFingerprint(line: string): string {
  // 时间/runId 在每次记录间变化；重复判断只比较已脱敏的事件内容。
  const record = JSON.parse(line) as Record<string, unknown>
  return createHash('sha256').update(JSON.stringify([record.source, record.event, record.details])).digest('hex')
}

export function formatFault(line: string, environment: string, recent: readonly string[], limit: number, droppedRecords = 0): string {
  const prefix = `{"kind":"fault-report","fault":${line.trimEnd()},"environment":${environment},"recent":[`
  const selected: string[] = []
  let bytes = Buffer.byteLength(prefix + `],"omittedRecentRecords":${recent.length},"droppedRecords":${droppedRecords}}\n`)
  for (let i = recent.length - 1; i >= 0; i--) {
    const candidate = recent[i]!.trimEnd()
    const size = Buffer.byteLength(candidate) + 1
    if (bytes + size > limit) break
    selected.push(candidate); bytes += size
  }
  return `${prefix}${selected.reverse().join(',')}],"omittedRecentRecords":${recent.length - selected.length},"droppedRecords":${droppedRecords}}\n`
}
