const DYNAMIC_VALUE_MAX_CHARS = 180

type ToolInput = Record<string, unknown>

const PRIORITY_KEYS = [
  'query', 'prompt', 'question', 'pattern', 'name', 'title', 'action',
  'url', 'path', 'file', 'filename', 'resource', 'target', 'id',
]

/** 动态 MCP / Provider 工具没有本地语义契约，只投影前两个有用且非敏感参数。 */
export function genericToolSummary(input: ToolInput): string {
  const entries = Object.entries(input)
    .filter(([key, value]) => !isSensitiveKey(key) && displayValue(value) !== '')
    .sort(([left], [right]) => keyPriority(left) - keyPriority(right))
    .slice(0, 2)
  return entries.map(([key, value]) => `${key}: ${displayValue(value)}`).join(' · ')
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return compact(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return ''
    const first = displayValue(value[0])
    return value.length === 1 ? first : `${first} 等 ${value.length} 项`
  }
  const nested = record(value)
  if (!nested) return ''
  const entry = Object.entries(nested).find(([key, item]) =>
    !isSensitiveKey(key) && displayValue(item) !== '')
  return entry ? `${entry[0]}=${displayValue(entry[1])}` : ''
}

function keyPriority(key: string): number {
  const normalized = key.toLowerCase()
  const index = PRIORITY_KEYS.findIndex((candidate) => normalized.includes(candidate))
  return index === -1 ? PRIORITY_KEYS.length : index
}

function isSensitiveKey(key: string): boolean {
  return /(?:api[_-]?key|access[_-]?key|token|secret|password|passphrase|authorization|credential|cookie|base64|private[_-]?key|(?:^|[_-])pat(?:$|[_-]))/iu.test(key)
}

function record(value: unknown): ToolInput | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ToolInput
    : null
}

function compact(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length > DYNAMIC_VALUE_MAX_CHARS
    ? `${normalized.slice(0, DYNAMIC_VALUE_MAX_CHARS - 1)}…`
    : normalized
}
