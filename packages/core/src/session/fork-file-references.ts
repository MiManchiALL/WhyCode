import type { ModelMessage } from 'ai'
import { PRESENT_TOOL_NAME, presentationSchema, readPresentationResult, type Presentation } from '../presentation.ts'
import type { ViewEvent } from './view-events.ts'
import { readCommandOutputResult, serializeCommandOutputResult } from '../tools/run-command/output-result.ts'

type VisibleEvent = Extract<ViewEvent, { type: 'core-event' }>['event']

/** 只重定位结构化文件引用；共享项目、文件正文、命令文本与来源 URL 保留原义。 */
export function forkFileReferences(rebase: (path: string) => string) {
  const calls = new Map<string, string>()
  const declaration = (value: Presentation): Presentation => ({
    ...value, files: value.files.map(file => ({ ...file, path: rebase(file.path) })),
  })
  const input = (value: unknown): unknown => {
    const parsed = presentationSchema.safeParse(value)
    return parsed.success ? declaration(parsed.data) : value
  }
  const result = (name: string | undefined, value: unknown, isError = false): unknown => {
    if (name === 'RunCommand' && typeof value === 'string') {
      const output = readCommandOutputResult(value)
      return output?.fullOutputPath
        ? serializeCommandOutputResult({ ...output, fullOutputPath: rebase(output.fullOutputPath) }) : value
    }
    if (name !== PRESENT_TOOL_NAME || isError) return value
    const parsed = typeof value === 'string' ? readPresentationResult(value) : null
    return parsed ? JSON.stringify(declaration(parsed)) : value
  }
  const toolInput = (name: string, value: unknown): unknown => {
    if (name === PRESENT_TOOL_NAME) return input(value)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const fields = value as Record<string, unknown>
    const paths = (item: unknown, keys: readonly string[]): unknown => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item
      return Object.fromEntries(Object.entries(item).map(([key, field]) =>
        [key, keys.includes(key) && typeof field === 'string' ? rebase(field) : field]))
    }
    if (['ReadFile', 'WriteFile', 'ListDir', 'Glob', 'Grep', 'ViewImage'].includes(name)) return paths(fields, ['path'])
    if (name === 'MoveFile') return paths(fields, ['source', 'destination'])
    if (name === 'EditFile' && Array.isArray(fields.edits)) return { ...fields, edits: fields.edits.map(item => paths(item, ['path'])) }
    if (name === 'DeleteFile' && Array.isArray(fields.paths)) return { ...fields, paths: fields.paths.map(path => typeof path === 'string' ? rebase(path) : path) }
    if (name === 'ReadPdf' && fields.sourceType === 'path') return paths(fields, ['sourceValue'])
    return value
  }
  const event = (value: VisibleEvent, owner = 'Main'): VisibleEvent => {
    if (value.type === 'peer-event') return {
      ...value, event: event(value.event, value.agentId) as typeof value.event,
    }
    if (value.type === 'tool-start') {
      const key = `${owner}:${value.toolUseId}`
      if (value.toolName === PRESENT_TOOL_NAME || value.toolName === 'RunCommand') calls.set(key, value.toolName)
      else calls.delete(key)
      return { ...value, input: toolInput(value.toolName, value.input) }
    }
    if (value.type === 'tool-end') {
      return { ...value,
        result: result(calls.get(`${owner}:${value.toolUseId}`), value.result, value.isError),
        ...(value.fileChanges ? { fileChanges: value.fileChanges.map(change => ({ ...change, path: rebase(change.path) })) } : {}),
      }
    }
    return value
  }
  return {
    messages: (messages: readonly ModelMessage[]): ModelMessage[] => messages.map((message): ModelMessage => {
      if (message.role === 'assistant' && Array.isArray(message.content)) return {
        ...message, content: message.content.map(part => part.type === 'tool-call'
          ? { ...part, input: toolInput(part.toolName, part.input) } : part),
      }
      if (message.role === 'tool') return {
        ...message, content: message.content.map(part => part.type === 'tool-result'
          && (part.output.type === 'text' || part.output.type === 'error-text')
          ? { ...part, output: { ...part.output, value: result(part.toolName, part.output.value, part.output.type === 'error-text') as string } } : part),
      }
      return message
    }),
    view: (value: ViewEvent): ViewEvent => value.type === 'core-event'
      ? { ...value, event: event(value.event) } : value,
  }
}
