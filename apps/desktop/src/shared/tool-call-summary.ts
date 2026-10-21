import { readPresentationResult } from '@whycode/core/presentation'
import { readCommandOutputResult, commandOutputDetails } from '@whycode/core/command-output'
import type { SkillSummary } from '@whycode/core/skills'
import { attachmentReferenceId, fileReadKind, parsePageRange } from '@whycode/core/file-read'
import { genericToolSummary } from './tool-call-summary-fallback.ts'

const SUMMARY_MAX_CHARS = 420
const VALUE_MAX_CHARS = 180
type ToolInput = Record<string, unknown>

export interface ToolCallSummary {
  parts: ToolSummaryPart[]
  separator: string
}

export interface ToolSummaryPart {
  text: string
  fixed?: boolean
}

interface ToolCallSummaryContext {
  result?: string
  skills?: readonly SkillSummary[]
  projectDir?: string | null
}

/**
 * 工具卡片只展示足以识别本次操作的关键参数；完整结果仍由展开区负责。
 * 已知工具按自身语义排序，动态 MCP / Provider 工具使用有界通用回退。
 */
export function summarizeToolCall(
  toolName: string,
  input: unknown,
  context: ToolCallSummaryContext = {},
): string {
  const summary = summarizeToolCallParts(toolName, input, context)
  return summary.parts.map(part => part.text).join(summary.separator)
}

/** 保留参数边界，让每项独立省略，避免长路径吞掉行数、范围或其它参数。 */
export function summarizeToolCallParts(
  toolName: string,
  input: unknown,
  context: ToolCallSummaryContext = {},
): ToolCallSummary {
  const value = record(input)
  if (!value) return boundedSummaryParts(parts(primitiveSummary(input)))

  const summary = knownToolSummary(toolName, value, context) ?? genericToolSummary(value)
  return boundedSummaryParts(typeof summary === 'string' ? parts(summary) : summary)
}

function knownToolSummary(
  toolName: string,
  input: ToolInput,
  context: ToolCallSummaryContext,
): string | ToolCallSummary | null {
  switch (toolName) {
    case 'ReadFile':
      if (fileReadKind(exactText(input, 'path')) === 'image') return parts(text(input, 'path'), fixed('high'))
      if (fileReadKind(exactText(input, 'path')) === 'pdf') return readPdfSummary(input)
      return parts(text(input, 'path'), fixed(lineRange(input, 'offset', 'limit')))
    case 'ListDir':
      return text(input, 'path') || context.projectDir || '.'
    case 'Glob':
      return parts(quote(text(input, 'pattern')), text(input, 'path') || context.projectDir || '.')
    case 'Grep':
      return parts(
        quote(text(input, 'pattern')),
        text(input, 'path') || context.projectDir || '.',
        prefixed('include', text(input, 'include')),
      )
    case 'WriteFile':
      return text(input, 'path')
    case 'EditFile':
      return fileCount(editPaths(input))
    case 'DeleteFile':
      return fileCount(unique(stringArray(input, 'paths')))
    case 'MoveFile':
      return { ...parts(text(input, 'source'), text(input, 'destination')), separator: ' → ' }
    case 'RunCommand':
      return compact(text(input, 'command'))
    case 'ListCommands':
      return ''
    case 'GetCommandOutput':
      return parts(taskId(input), fixed(numberLabel(input, 'offset', 'offset')))
    case 'WriteCommandInput':
      return parts(taskId(input), fixed(inputLengthSummary(input)))
    case 'StopCommand':
      return taskId(input)
    case 'WebSearch':
      return parts(querySummary(input.query), fixed(recencySummary(input)))
    case 'WebFetch':
      return parts(text(input, 'url'), fixed(lineRange(input, 'offset', 'limit')))
    case 'WebFind':
      return parts(quote(text(input, 'pattern')), text(input, 'url'))
    case 'AnalyzeImage':
      return parts(inlineText(input.question), fixed(arrayCount(input, 'attachmentIds', 'image', 'images')))
    case 'CaptureScreenshot':
      return screenshotSummary(input)
    case 'Browser':
      return text(input, 'description') || (text(input, 'code') ? '操作网页' : '加载浏览器指引')
    case 'Skill':
      return skillSummary(input, context)
    case 'Present':
      return arrayCount(input, 'files', 'file', 'files')
    case 'AskUserQuestion':
      return arrayCount(input, 'questions', 'question', 'questions')
    case 'CreateTaskPlan':
      return arrayCount(input, 'items', 'milestone', 'milestones')
    case 'ResumeTaskPlan':
      return prefixed('plan ID', shortId(text(input, 'plan_id')))
    case 'UpdateTaskItem':
      return taskUpdateSummary(input)
    case 'CloseTaskPlan':
      return prefixed('plan ID', shortId(text(input, 'plan_id')))
    case 'Subagent':
      return text(input, 'agent_id')
    case 'SendSubagentMessage':
      return shortId(text(input, 'subagent_id'))
    case 'ListSubagents':
      return ''
    case 'ToolSearch':
      return parts(quote(text(input, 'query')), fixed(numberLabel(input, 'max_results', 'max results')))
    case 'SubmitProtocolOutput':
      return protocolSummary(input)
    default:
      return null
  }
}

export function toolCallDetails(
  toolName: string,
  input: unknown,
  result: string | undefined,
  isError: boolean,
): string | null {
  if (toolName === 'RunCommand' && result) {
    const command = readCommandOutputResult(result)
    if (command) return commandOutputDetails(command)
  }
  if (isError) return null
  const value = record(input)
  if (!value) return null
  switch (toolName) {
    case 'EditFile':
      return editPaths(value).join('\n')
    case 'DeleteFile':
      return unique(stringArray(value, 'paths')).join('\n')
    case 'Present': {
      const presentation = result ? readPresentationResult(result) : null
      return presentation ? presentation.files.map(file => file.description ? `${file.path} — ${file.description}` : file.path)
        .join('\n') || '本次回答未列出成品文件' : null
    }
    case 'AskUserQuestion':
      return answeredQuestionDetails(value, result)
    case 'Subagent':
      return subagentDetails(value, result)
    case 'SendSubagentMessage':
      return text(value, 'prompt')
    default:
      return null
  }
}

/** 文件编辑类工具影响的显示路径；折叠列表按文件拆行时复用同一解析规则。 */
export function toolCallFilePaths(toolName: string, input: unknown): string[] {
  const value = record(input)
  if (!value) return []
  switch (toolName) {
    case 'WriteFile': {
      const path = exactText(value, 'path')
      return path ? [path] : []
    }
    case 'EditFile':
      return exactEditPaths(value)
    case 'DeleteFile':
      return unique(exactStringArray(value, 'paths'))
    case 'MoveFile': {
      const path = exactText(value, 'destination')
      return path ? [path] : []
    }
    default:
      return []
  }
}

/** MoveFile 的源路径只用于判断“同目录重命名”；可预览资源始终是目标路径。 */
export function toolCallMoveSource(input: unknown): string | null {
  const value = record(input)
  if (!value) return null
  const path = exactText(value, 'source')
  return path || null
}

function editPaths(input: ToolInput): string[] {
  const edits = Array.isArray(input.edits)
    ? input.edits.filter((item): item is ToolInput => record(item) !== null)
    : []
  return unique(edits.map((edit) => text(edit, 'path')).filter(Boolean))
}

/** 文件身份不能复用 UI 摘要截断，否则长路径无法匹配逐文件统计。 */
function exactEditPaths(input: ToolInput): string[] {
  const edits = Array.isArray(input.edits)
    ? input.edits.filter((item): item is ToolInput => record(item) !== null)
    : []
  return unique(edits.map((edit) => exactText(edit, 'path')).filter(Boolean))
}

function fileCount(paths: readonly string[]): string {
  return count(paths.length, 'file', 'files')
}

function querySummary(value: unknown): string {
  const queries = typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
  return queries.map(inlineText).filter(Boolean).join(' ')
}

function recencySummary(input: ToolInput): string {
  const recency = text(input, 'recency')
  return recency ? `past ${recency}` : 'all time'
}

function screenshotSummary(input: ToolInput): string | ToolCallSummary {
  const target = text(input, 'target')
  if (input.target === 'window') {
    return parts(fixed(target), text(input, 'window_title') || text(input, 'window_id'))
  }
  if (input.target === 'screen' && input.region) {
    return parts(target, prefixed('region', imageRegionSize(input.region)))
  }
  return target
}

function readPdfSummary(input: ToolInput): ToolCallSummary {
  const path = text(input, 'path')
  const id = attachmentReferenceId(path)
  const source = id ? prefixed('attachment', shortId(id)) : path
  const range = parsePageRange(text(input, 'pages'))
  return parts(source, fixed(range
    ? `pages ${range.startPage}–${range.startPage + range.pageCount - 1}`
    : 'from page 1'))
}

function skillSummary(input: ToolInput, context: ToolCallSummaryContext): ToolCallSummary {
  const skillId = text(input, 'skillId')
  const skill = context.skills?.find((item) => item.id === skillId)
  const fallbackName = skillNameFromResult(context.result) || shortId(skillId)
  return parts(skill?.name ?? fallbackName, skill?.description ?? '')
}

function skillNameFromResult(result: string | undefined): string {
  if (!result) return ''
  const match = /<skill-resource\s+name="([^"]+)"/u.exec(result)
  return match?.[1] ?? ''
}

function answeredQuestionDetails(input: ToolInput, result: string | undefined): string {
  const questions = Array.isArray(input.questions)
    ? input.questions.filter((item): item is ToolInput => record(item) !== null)
    : []
  if (result?.startsWith('Question: ')) return result
  return questions.map((question) => [
    `Question: ${text(question, 'question')}`,
    'Answer: Waiting for response',
  ].join('\n')).join('\n\n')
}

function subagentDetails(input: ToolInput, result: string | undefined): string {
  const subagentId = result
    ? /subagent_id:\s*([0-9a-f-]{36})/iu.exec(result)?.[1] ?? ''
    : ''
  return [
    ...(subagentId ? [`subagent_id: ${subagentId}`] : []),
    ...(text(input, 'description') ? [`description: ${text(input, 'description')}`] : []),
  ].join('\n')
}

function taskUpdateSummary(input: ToolInput): ToolCallSummary {
  const status = input.status === 'in_progress'
    ? 'in progress'
    : input.status === 'completed' ? 'complete' : ''
  const transition = joinWith(' → ', text(input, 'item_id'), status)
  const changes = Array.isArray(input.changes) ? input.changes.length : 0
  return parts(transition, fixed(count(changes, 'plan change', 'plan changes')))
}

function protocolSummary(input: ToolInput): string | ToolCallSummary {
  const candidate = record(input.candidate)
  if (candidate) return quote(text(candidate, 'summary'))
  return parts(text(input, 'vote'), quote(text(input, 'reason')))
}

function lineRange(input: ToolInput, startKey: string, countKey: string): string {
  const start = number(input, startKey)
  const count = number(input, countKey)
  if (start === null && count === null) return ''
  if (start !== null && count !== null) return `lines ${start}–${start + count - 1}`
  if (start !== null) return `from line ${start}`
  return `first ${count} lines`
}

function imageRegionSize(value: unknown): string {
  const region = record(value)
  if (!region) return ''
  const width = number(region, 'width')
  const height = number(region, 'height')
  return width === null || height === null ? '' : `${width}×${height}`
}

function taskId(input: ToolInput): string {
  return prefixed('task ID', shortId(text(input, 'taskId')))
}

function inputLengthSummary(input: ToolInput): string {
  const value = typeof input.input === 'string' ? input.input : ''
  return `${value.length} ${value.length === 1 ? 'character' : 'characters'}`
}

function arrayCount(input: ToolInput, key: string, singular: string, plural: string): string {
  const values = Array.isArray(input[key]) ? input[key] : []
  return count(values.length, singular, plural)
}

function numberLabel(input: ToolInput, key: string, prefix: string): string {
  const value = number(input, key)
  return value === null ? '' : `${prefix} ${value}`
}

function record(value: unknown): ToolInput | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ToolInput
    : null
}

function text(input: ToolInput, key: string): string {
  return typeof input[key] === 'string' ? compact(input[key] as string) : ''
}

function exactText(input: ToolInput, key: string): string {
  return typeof input[key] === 'string' ? input[key] as string : ''
}

function number(input: ToolInput, key: string): number | null {
  return typeof input[key] === 'number' && Number.isFinite(input[key])
    ? input[key] as number
    : null
}

function stringArray(input: ToolInput, key: string): string[] {
  return Array.isArray(input[key])
    ? input[key].filter((item): item is string => typeof item === 'string').map(compact)
    : []
}

function exactStringArray(input: ToolInput, key: string): string[] {
  return Array.isArray(input[key])
    ? input[key].filter((item): item is string => typeof item === 'string')
    : []
}

function primitiveSummary(value: unknown): string {
  if (typeof value === 'string') return compact(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function compact(value: string): string {
  return clip(inlineText(value), VALUE_MAX_CHARS)
}

function inlineText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
}

function quote(value: string): string {
  return value ? `“${value}”` : ''
}

function prefixed(prefix: string, value: string): string {
  return value ? `${prefix} ${value}` : ''
}

function shortId(value: string): string {
  if (!value) return ''
  const normalized = value.startsWith('skill:') ? value.slice('skill:'.length) : value
  return normalized.length > 12 ? `${normalized.slice(0, 8)}…` : normalized
}

function count(value: number, singular: string, plural: string): string {
  return value > 0 ? `${value} ${value === 1 ? singular : plural}` : ''
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function parts(...values: (string | ToolSummaryPart)[]): ToolCallSummary {
  return {
    parts: values.map(value => typeof value === 'string' ? { text: value } : value).filter(part => part.text),
    separator: ' · ',
  }
}

function fixed(text: string): ToolSummaryPart {
  return { text, fixed: true }
}

function joinWith(separator: string, ...parts: string[]): string {
  return parts.filter(Boolean).join(separator)
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

function boundedSummaryParts(summary: ToolCallSummary): ToolCallSummary {
  const separatorLength = Math.max(0, summary.parts.length - 1) * summary.separator.length
  const limit = Math.floor((SUMMARY_MAX_CHARS - separatorLength) / Math.max(1, summary.parts.length))
  return { ...summary, parts: summary.parts.map(part => ({ ...part, text: clip(part.text, limit) })) }
}
