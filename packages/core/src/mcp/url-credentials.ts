const URL_CANDIDATE_PATTERN =
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`\\]+/giu

const REDACTED_URL_VALUE = 'REDACTED'
const TRAILING_URL_PUNCTUATION = new Set([
  '.', ',', ';', ':', '!', '?',
  '。', '，', '；', '：', '！', '？',
])

const SENSITIVE_URL_PARAMETER_NAMES = new Set([
  'accesskey',
  'accesskeyid',
  'accesstoken',
  'apikey',
  'auth',
  'authorization',
  'awsaccesskeyid',
  'clientsecret',
  'code',
  'credential',
  'credentials',
  'googleaccessid',
  'idtoken',
  'jwt',
  'key',
  'keypairid',
  'nonce',
  'password',
  'passwd',
  'refreshtoken',
  'secret',
  'session',
  'sessionid',
  'sharedaccesssignature',
  'sig',
  'signature',
  'state',
  'subscriptionkey',
  'ticket',
  'token',
  'xapikey',
  'xamzcredential',
  'xamzsecuritytoken',
  'xamzsignature',
  'xgoogcredential',
  'xgoogsecuritytoken',
  'xgoogsignature',
])

/**
 * MCP 外部数据可能包含预签名下载地址或 OAuth 回调地址。
 * 只改写可解析 URL 中的凭据位置，普通文本和普通查询参数保持原样。
 */
export function redactUrlCredentials(value: string): string {
  return value.replace(URL_CANDIDATE_PATTERN, redactUrlCandidate)
}

function redactUrlCandidate(candidate: string): string {
  const split = splitTrailingPunctuation(candidate)
  let url: URL
  try {
    url = new URL(split.url)
  } catch {
    return candidate
  }

  let changed = false
  if (url.username) {
    url.username = REDACTED_URL_VALUE
    changed = true
  }
  if (url.password) {
    url.password = REDACTED_URL_VALUE
    changed = true
  }

  const entries = [...url.searchParams.entries()]
  if (entries.some(([name]) => isSensitiveParameterName(name))) {
    const redacted = new URLSearchParams()
    for (const [name, parameterValue] of entries) {
      redacted.append(
        name,
        isSensitiveParameterName(name) ? REDACTED_URL_VALUE : parameterValue,
      )
    }
    url.search = redacted.toString()
    changed = true
  }

  const fragment = redactFragment(url.hash)
  if (fragment.changed) {
    url.hash = fragment.value
    changed = true
  }

  return changed ? `${url.toString()}${split.trailing}` : candidate
}

function splitTrailingPunctuation(value: string): { url: string; trailing: string } {
  const unmatchedClosers = new Map([
    [')', Math.max(countCharacter(value, ')') - countCharacter(value, '('), 0)],
    [']', Math.max(countCharacter(value, ']') - countCharacter(value, '['), 0)],
    ['}', Math.max(countCharacter(value, '}') - countCharacter(value, '{'), 0)],
  ])
  let end = value.length
  while (end > 0) {
    const character = value[end - 1]!
    if (TRAILING_URL_PUNCTUATION.has(character)) {
      end--
      continue
    }
    const unmatched = unmatchedClosers.get(character) ?? 0
    if (unmatched > 0) {
      unmatchedClosers.set(character, unmatched - 1)
      end--
      continue
    }
    break
  }
  return { url: value.slice(0, end), trailing: value.slice(end) }
}

function countCharacter(value: string, expected: string): number {
  let count = 0
  for (const character of value) {
    if (character === expected) count++
  }
  return count
}

function redactFragment(hash: string): { value: string; changed: boolean } {
  if (!hash.includes('=')) return { value: hash, changed: false }
  let changed = false
  const value = hash.replace(
    /(^|[#?&])([^=?&#]+)=([^&]*)/gu,
    (match, prefix: string, rawName: string) => {
      if (!isSensitiveParameterName(decodeParameterName(rawName))) return match
      changed = true
      return `${prefix}${rawName}=${REDACTED_URL_VALUE}`
    },
  )
  return { value, changed }
}

function decodeParameterName(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/gu, ' '))
  } catch {
    return value
  }
}

function isSensitiveParameterName(value: string): boolean {
  const normalized = value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/gu, '')
  return SENSITIVE_URL_PARAMETER_NAMES.has(normalized)
}
