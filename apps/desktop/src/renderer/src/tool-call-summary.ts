import type { SkillSummary } from '@whycode/core/skills'
import { genericToolSummary } from './tool-call-summary-fallback.ts'

const SUMMARY_MAX_CHARS = 420
const VALUE_MAX_CHARS = 180
type ToolInput = Record<string, unknown>

export interface ToolCallSummary {
  primary: string
  trailing: string
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
  return join(summary.primary, summary.trailing)
}

/** 尾部信息单独返回，工具卡可以在主内容省略时仍完整保留时间范围或数量。 */
export function summarizeToolCallParts(
  toolName: string,
  input: unknown,
  context: ToolCallSummaryContext = {},
): ToolCallSummary {
  const value = record(input)
  if (!value) return boundedSummary(primitiveSummary(input))

  const summary = knownToolSummary(toolName, value, context) ?? genericToolSummary(value)
  return typeof summary === 'string' ? boundedSummary(summary) : boundedSummaryParts(summary)
}

function knownToolSummary(
  toolName: string,
  input: ToolInput,
  context: ToolCallSummaryContext,
): string | ToolCallSummary | null {
  switch (toolName) {
    case 'ReadFile':
      return join(text(input, 'path'), lineRange(input, 'offset', 'limit'))
    case 'ListDir':
      return text(input, 'path') || context.projectDir || '.'
    case 'Glob':
      return join(quote(text(input, 'pattern')), text(input, 'path') || context.projectDir || '.')
    case 'Grep':
      return join(
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
      return arrow(text(input, 'source'), text(input, 'destination'))
    case 'RunCommand':
      return compact(text(input, 'command'))
    case 'ListCommands':
      return ''
    case 'GetCommandOutput':
      return join(taskId(input), numberLabel(input, 'offset', 'offset'))
    case 'WriteCommandInput':
      return join(taskId(input), inputLengthSummary(input))
    case 'StopCommand':
      return taskId(input)
    case 'WebSearch':
      return { primary: querySummary(input.query), trailing: recencySummary(input) }
    case 'WebFetch':
      return join(text(input, 'url'), lineRange(input, 'offset', 'limit'))
    case 'WebFind':
      return join(quote(text(input, 'pattern')), text(input, 'url'))
    case 'ViewImage':
      return join(text(input, 'path'), imageRegionSummary(input.region), detailSummary(input))
    case 'AnalyzeImage':
      return {
        primary: inlineText(input.question),
        trailing: arrayCount(input, 'attachmentIds', 'image', 'images'),
      }
    case 'CaptureScreenshot':
      return screenshotSummary(input)
    case 'ReadPdf':
      return join(pdfSourceSummary(input), pageRange(input, 'startPage', 'pageCount'))
    case 'BuildOfficeArtifact':
      return join(
        text(input, 'outputPath'),
        upper(text(input, 'format')),
        text(input, 'mode'),
      )
    case 'InspectOffice':
      return join(
        text(input, 'path'),
        text(input, 'view'),
        officeLocationSummary(input),
        unitRange(input),
      )
    case 'RenderOffice':
      return join(
        text(input, 'path'),
        text(input, 'view'),
        pageRange(input, 'startPage', 'pageCount'),
      )
    case 'Skill':
      return skillSummary(input, context)
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
      return join(quote(text(input, 'query')), numberLabel(input, 'max_results', 'max results'))
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
  if (isError) return null
  const value = record(input)
  if (!value) return null
  switch (toolName) {
    case 'EditFile':
      return editPaths(value).join('\n')
    case 'DeleteFile':
      return unique(stringArray(value, 'paths')).join('\n')
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
    default:
      return []
  }
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

function screenshotSummary(input: ToolInput): string {
  const target = text(input, 'target')
  if (input.target === 'window') {
    return join(target, text(input, 'window_title'))
  }
  if (input.target === 'screen' && input.region) {
    return join(target, prefixed('region', imageRegionSize(input.region)))
  }
  return target
}

function pdfSourceSummary(input: ToolInput): string {
  const source = text(input, 'sourceValue')
  return input.sourceType === 'attachment'
    ? prefixed('attachment', shortId(source))
    : source
}

function officeLocationSummary(input: ToolInput): string {
  if (text(input, 'sheetName')) {
    return join(prefixed('sheet', text(input, 'sheetName')), text(input, 'range'))
  }
  if (typeof input.slideNumber === 'number') return `slide ${input.slideNumber}`
  return ''
}

function skillSummary(input: ToolInput, context: ToolCallSummaryContext): string {
  const skillId = text(input, 'skillId')
  const skill = context.skills?.find((item) => item.id === skillId)
  const fallbackName = skillNameFromResult(context.result) || shortId(skillId)
  return join(skill?.name ?? fallbackName, skill?.description ?? '')
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

function taskUpdateSummary(input: ToolInput): string {
  const status = input.status === 'in_progress'
    ? 'in progress'
    : input.status === 'completed' ? 'complete' : ''
  const transition = joinWith(' → ', text(input, 'item_id'), status)
  const changes = Array.isArray(input.changes) ? input.changes.length : 0
  return join(transition, count(changes, 'plan change', 'plan changes'))
}

function protocolSummary(input: ToolInput): string {
  const candidate = record(input.candidate)
  if (candidate) return quote(text(candidate, 'summary'))
  return join(text(input, 'vote'), quote(text(input, 'reason')))
}

function lineRange(input: ToolInput, startKey: string, countKey: string): string {
  const start = number(input, startKey)
  const count = number(input, countKey)
  if (start === null && count === null) return ''
  if (start !== null && count !== null) return `lines ${start}–${start + count - 1}`
  if (start !== null) return `from line ${start}`
  return `first ${count} lines`
}

function pageRange(input: ToolInput, startKey: string, countKey: string): string {
  const start = number(input, startKey)
  const count = number(input, countKey)
  if (start === null && count === null) return ''
  const first = start ?? 1
  if (count !== null) return `pages ${first}–${first + count - 1}`
  return `from page ${first}`
}

function imageRegionSummary(value: unknown): string {
  const region = record(value)
  if (!region) return ''
  const x = number(region, 'x')
  const y = number(region, 'y')
  const width = number(region, 'width')
  const height = number(region, 'height')
  if ([x, y, width, height].some((item) => item === null)) return ''
  return `crop ${x},${y} ${width}×${height}`
}

function imageRegionSize(value: unknown): string {
  const region = record(value)
  if (!region) return ''
  const width = number(region, 'width')
  const height = number(region, 'height')
  return width === null || height === null ? '' : `${width}×${height}`
}

function detailSummary(input: ToolInput): string {
  const detail = text(input, 'detail')
  return detail === 'original' || detail === 'high' ? detail : ''
}

function taskId(input: ToolInput): string {
  return prefixed('task ID', shortId(text(input, 'taskId')))
}

function inputLengthSummary(input: ToolInput): string {
  const value = typeof input.input === 'string' ? input.input : ''
  return `${value.length} ${value.length === 1 ? 'character' : 'characters'}`
}

function unitRange(input: ToolInput): string {
  const start = number(input, 'startUnit')
  const count = number(input, 'unitCount')
  if (start === null && count === null) return ''
  const first = start ?? 1
  return count === null ? `from unit ${first}` : `units ${first}–${first + count - 1}`
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

function arrow(source: string, destination: string): string {
  return source && destination ? `${source} → ${destination}` : source || destination
}

function upper(value: string): string {
  return value.toUpperCase()
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

function join(...parts: string[]): string {
  return joinWith(' · ', ...parts)
}

function joinWith(separator: string, ...parts: string[]): string {
  return parts.filter(Boolean).join(separator)
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}

function boundedSummary(value: string): ToolCallSummary {
  return { primary: clip(value, SUMMARY_MAX_CHARS), trailing: '' }
}

function boundedSummaryParts(summary: ToolCallSummary): ToolCallSummary {
  const trailing = clip(summary.trailing, SUMMARY_MAX_CHARS)
  const separatorLength = summary.primary && trailing ? 3 : 0
  const primaryLimit = Math.max(1, SUMMARY_MAX_CHARS - trailing.length - separatorLength)
  return { primary: clip(summary.primary, primaryLimit), trailing }
}
