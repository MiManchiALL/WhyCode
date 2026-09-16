import type { ModelMessage } from 'ai'
import { PRESENT_TOOL_NAME, presentationSchema, readPresentationResult, type Presentation } from '../presentation.ts'
import type { ViewEvent } from './view-events.ts'

type VisibleEvent = Extract<ViewEvent, { type: 'core-event' }>['event']

/** 复制工作区时重定位结构化交付引用；正文与来源 URL 保留原义。 */
export function forkPresentations(rebase: (path: string) => string) {
  const calls = new Set<string>()
  const declaration = (value: Presentation): Presentation => ({
    ...value, files: value.files.map(file => ({ ...file, path: rebase(file.path) })),
  })
  const input = (value: unknown): unknown => {
    const parsed = presentationSchema.safeParse(value)
    return parsed.success ? declaration(parsed.data) : value
  }
  const result = (value: unknown): unknown => {
    const parsed = typeof value === 'string' ? readPresentationResult(value) : null
    return parsed ? JSON.stringify(declaration(parsed)) : value
  }
  const event = (value: VisibleEvent, owner = 'Main'): VisibleEvent => {
    if (value.type === 'peer-event') return {
      ...value, event: event(value.event, value.agentId) as typeof value.event,
    }
    if (value.type === 'tool-start') {
      const key = `${owner}:${value.toolUseId}`
      if (value.toolName !== PRESENT_TOOL_NAME) { calls.delete(key); return value }
      calls.add(key)
      return { ...value, input: input(value.input) }
    }
    if (value.type === 'tool-end' && !value.isError && calls.has(`${owner}:${value.toolUseId}`)) {
      return { ...value, result: result(value.result) }
    }
    return value
  }
  return {
    messages: (messages: readonly ModelMessage[]): ModelMessage[] => messages.map((message): ModelMessage => {
      if (message.role === 'assistant' && Array.isArray(message.content)) return {
        ...message, content: message.content.map(part => part.type === 'tool-call' && part.toolName === PRESENT_TOOL_NAME
          ? { ...part, input: input(part.input) } : part),
      }
      if (message.role === 'tool') return {
        ...message, content: message.content.map(part => part.type === 'tool-result'
          && part.toolName === PRESENT_TOOL_NAME && part.output.type === 'text'
          ? { ...part, output: { ...part.output, value: result(part.output.value) as string } } : part),
      }
      return message
    }),
    view: (value: ViewEvent): ViewEvent => value.type === 'core-event'
      ? { ...value, event: event(value.event) } : value,
  }
}
