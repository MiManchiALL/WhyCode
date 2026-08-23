import type { AssistantModelMessage, ModelMessage } from 'ai'

const RESERVED_HOST_PREFIXES = [
  '<system-reminder',
  '<subagent-settlement',
  '<task-notification',
  '<whycode-',
] as const

const JSON_PROBE_LIMIT = 512
const UUID_VALUE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}'
const SUBAGENT_ID_FIELD = new RegExp(`"subagent_id"\\s*:\\s*"${UUID_VALUE}"`)
const ACTIVATION_ID_FIELD = new RegExp(`"activation_id"\\s*:\\s*"${UUID_VALUE}"`)
const TERMINAL_OUTCOME_FIELD = /"outcome"\s*:\s*"(?:completed|error|aborted|limit|refusal)"/

/**
 * Holds only the leading characters needed to distinguish normal prose from a reserved
 * host-control block. Once classified, later deltas pass through without buffering.
 */
export class AssistantTextGate {
  private buffer = ''
  private state: 'probing' | 'allowed' | 'blocked' = 'probing'
  private readonly emit: (text: string) => void

  constructor(emit: (text: string) => void) {
    this.emit = emit
  }

  push(text: string): void {
    if (!text) return
    if (this.state === 'allowed') {
      this.emit(text)
      return
    }
    if (this.state === 'blocked') return
    this.buffer += text
    const candidate = this.buffer.trimStart()
    if (!candidate) return
    if (isReservedHostOutput(candidate)) {
      this.state = 'blocked'
      this.buffer = ''
      return
    }
    if (RESERVED_HOST_PREFIXES.some((prefix) => prefix.startsWith(candidate))) return
    // settlement 的模型回显有时只保留内部 JSON。仅对顶层 JSON 有界探测，
    // 看到协议唯一字段组合就拦截；普通 JSON 最多延迟少量前导字符。
    if (candidate.startsWith('{') && candidate.length < JSON_PROBE_LIMIT) return
    this.state = 'allowed'
    this.emit(this.buffer)
    this.buffer = ''
  }

  finish(): void {
    if (
      this.state === 'probing'
      && this.buffer
      && !isReservedHostOutput(this.buffer.trimStart())
    ) this.emit(this.buffer)
    this.buffer = ''
  }
}

export function sanitizeAssistantControlOutput(messages: ModelMessage[]): {
  messages: ModelMessage[]
  rejected: boolean
} {
  const text = messages
    .filter((message) => message.role === 'assistant')
    .map(messageText)
    .join('\n')
    .trimStart()
  if (!isReservedHostOutput(text)) {
    return { messages, rejected: false }
  }
  const sanitized: ModelMessage[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') {
      sanitized.push(message)
      continue
    }
    if (typeof message.content === 'string') continue
    const content: AssistantModelMessage['content'] = message.content.filter(
      (part) => part.type !== 'text',
    )
    if (content.length > 0) sanitized.push({ ...message, content })
  }
  return { rejected: true, messages: sanitized }
}

function isReservedHostOutput(text: string): boolean {
  if (RESERVED_HOST_PREFIXES.some((prefix) => text.startsWith(prefix))) return true
  if (!text.startsWith('{')) return false
  return SUBAGENT_ID_FIELD.test(text)
    && ACTIVATION_ID_FIELD.test(text)
    && TERMINAL_OUTCOME_FIELD.test(text)
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
}
