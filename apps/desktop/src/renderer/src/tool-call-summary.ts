import { genericToolSummary } from './tool-call-summary-fallback.ts'

const SUMMARY_MAX_CHARS = 420
const VALUE_MAX_CHARS = 180
const DEFAULT_SCOPE = '项目根目录'

type ToolInput = Record<string, unknown>

/**
 * 工具卡片只展示足以识别本次操作的关键参数；完整结果仍由展开区负责。
 * 已知工具按自身语义排序，动态 MCP / Provider 工具使用有界通用回退。
 */
export function summarizeToolCall(toolName: string, input: unknown): string {
  const value = record(input)
  if (!value) return primitiveSummary(input)

  const summary = knownToolSummary(toolName, value) ?? genericToolSummary(value)
  return clip(summary, SUMMARY_MAX_CHARS)
}

function knownToolSummary(toolName: string, input: ToolInput): string | null {
  switch (toolName) {
    case 'ReadFile':
      return join(text(input, 'path'), lineRange(input, 'offset', 'limit'))
    case 'ListDir':
      return text(input, 'path') || DEFAULT_SCOPE
    case 'Glob':
      return join(quote(text(input, 'pattern')), text(input, 'path') || DEFAULT_SCOPE)
    case 'Grep':
      return join(
        quote(text(input, 'pattern')),
        text(input, 'path') || DEFAULT_SCOPE,
        prefixed('文件', text(input, 'include')),
      )
    case 'WriteFile':
      return text(input, 'path')
    case 'EditFile':
      return editSummary(input)
    case 'DeleteFile':
      return pathListSummary(stringArray(input, 'paths'))
    case 'MoveFile':
      return arrow(text(input, 'source'), text(input, 'destination'))
    case 'RunCommand':
      return join(
        compact(text(input, 'command')),
        input.runInBackground === true
          ? input.wakeOnCompletion === true ? '后台完成后唤醒' : '后台运行'
          : '',
        prefixed('目录', text(input, 'cwd')),
      )
    case 'ListCommands':
      return '当前会话'
    case 'GetCommandOutput':
      return join(taskId(input), numberLabel(input, 'offset', '偏移'))
    case 'WriteCommandInput':
      return join(
        taskId(input),
        inputLengthSummary(input),
        input.appendNewline === false ? '不追加换行' : '',
        input.closeAfterWrite === true ? '写入后关闭 stdin' : '',
      )
    case 'StopCommand':
      return taskId(input)
    case 'WebSearch':
      return join(
        querySummary(input.query),
        domainsSummary(input),
        prefixed('时间', text(input, 'recency')),
      )
    case 'WebFetch':
      return join(text(input, 'url'), lineRange(input, 'offset', 'limit'))
    case 'WebFind':
      return join(quote(text(input, 'pattern')), text(input, 'url'))
    case 'ViewImage':
      return join(text(input, 'path'), imageRegionSummary(input.region), detailSummary(input))
    case 'AnalyzeImage':
      return join(quote(text(input, 'question')), countLabel(input, 'attachmentIds', '张图片'))
    case 'CaptureScreenshot':
      return screenshotSummary(input)
    case 'ReadPdf':
      return join(pdfSourceSummary(input), pageRange(input, 'startPage', 'pageCount'))
    case 'BuildOfficeArtifact':
      return join(
        text(input, 'outputPath'),
        upper(text(input, 'format')),
        input.mode === 'template' ? '模板模式' : input.mode === 'create' ? '从零创建' : '',
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
        input.view === 'overview' ? '总览' : input.view === 'pages' ? '逐页' : '',
        pageRange(input, 'startPage', 'pageCount'),
      )
    case 'Skill':
      return join(
        text(input, 'resourcePath') || 'SKILL.md',
        shortId(text(input, 'skillId')),
      )
    case 'AskUserQuestion':
      return questionSummary(input)
    case 'CreateTaskPlan':
      return join(quote(text(input, 'goal')), countLabel(input, 'items', '个里程碑'))
    case 'ResumeTaskPlan':
      return prefixed('计划', shortId(text(input, 'plan_id')))
    case 'UpdateTaskItem':
      return taskUpdateSummary(input)
    case 'CloseTaskPlan':
      return '当前计划'
    case 'Subagent':
      return join(quote(text(input, 'description')), text(input, 'agent_id'))
    case 'SendSubagentMessage':
      return join(prefixed('子代理', shortId(text(input, 'subagent_id'))), quote(text(input, 'prompt')))
    case 'ListSubagents':
      return '当前会话'
    case 'ToolSearch':
      return join(quote(text(input, 'query')), numberLabel(input, 'max_results', '最多'))
    case 'SubmitProtocolOutput':
      return protocolSummary(input)
    default:
      return null
  }
}

function editSummary(input: ToolInput): string {
  const edits = Array.isArray(input.edits)
    ? input.edits.filter((item): item is ToolInput => record(item) !== null)
    : []
  const paths = [...new Set(edits.map((edit) => text(edit, 'path')).filter(Boolean))]
  return join(pathListSummary(paths), edits.length ? `${edits.length} 处修改` : '')
}

function pathListSummary(paths: readonly string[]): string {
  if (paths.length === 0) return ''
  if (paths.length === 1) return paths[0]!
  return `${paths[0]} 等 ${paths.length} 个文件`
}

function querySummary(value: unknown): string {
  const queries = typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
  if (queries.length === 0) return ''
  if (queries.length === 1) return quote(queries[0]!)
  return `${quote(queries[0]!)} 等 ${queries.length} 个查询`
}

function domainsSummary(input: ToolInput): string {
  const domains = stringArray(input, 'domains')
  if (domains.length === 0) return ''
  return domains.length === 1 ? domains[0]! : `${domains[0]} 等 ${domains.length} 个域名`
}

function screenshotSummary(input: ToolInput): string {
  if (input.target === 'window') {
    return join('窗口', quote(text(input, 'window_title')))
  }
  if (input.target === 'region') return imageRegionSummary(input.region) || '区域'
  return join('屏幕', prefixed('显示器', text(input, 'display_id')))
}

function pdfSourceSummary(input: ToolInput): string {
  const source = text(input, 'sourceValue')
  return input.sourceType === 'attachment'
    ? prefixed('附件', shortId(source))
    : source
}

function officeLocationSummary(input: ToolInput): string {
  if (text(input, 'sheetName')) {
    return join(prefixed('工作表', text(input, 'sheetName')), text(input, 'range'))
  }
  if (typeof input.slideNumber === 'number') return `第 ${input.slideNumber} 页`
  return ''
}

function questionSummary(input: ToolInput): string {
  const questions = Array.isArray(input.questions)
    ? input.questions.filter((item): item is ToolInput => record(item) !== null)
    : []
  return join(
    quote(questions[0] ? text(questions[0], 'question') : ''),
    questions.length ? `${questions.length} 个问题` : '',
  )
}

function taskUpdateSummary(input: ToolInput): string {
  const status = input.status === 'in_progress'
    ? '进行中'
    : input.status === 'completed' ? '已完成' : ''
  const transition = joinWith(' → ', text(input, 'item_id'), status)
  const changes = Array.isArray(input.changes) ? input.changes.length : 0
  return join(transition, changes ? `${changes} 项计划调整` : '')
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
  if (start !== null && count !== null) return `第 ${start}–${start + count - 1} 行`
  if (start !== null) return `从第 ${start} 行`
  return `前 ${count} 行`
}

function pageRange(input: ToolInput, startKey: string, countKey: string): string {
  const start = number(input, startKey)
  const count = number(input, countKey)
  if (start === null && count === null) return ''
  const first = start ?? 1
  if (count !== null) return `第 ${first}–${first + count - 1} 页`
  return `从第 ${first} 页`
}

function imageRegionSummary(value: unknown): string {
  const region = record(value)
  if (!region) return ''
  const x = number(region, 'x')
  const y = number(region, 'y')
  const width = number(region, 'width')
  const height = number(region, 'height')
  if ([x, y, width, height].some((item) => item === null)) return ''
  return `区域 ${x},${y} ${width}×${height}`
}

function detailSummary(input: ToolInput): string {
  const detail = text(input, 'detail')
  return detail === 'original' ? '原图' : detail === 'high' ? '高精度' : ''
}

function taskId(input: ToolInput): string {
  return prefixed('任务', shortId(text(input, 'taskId')))
}

function inputLengthSummary(input: ToolInput): string {
  const value = typeof input.input === 'string' ? input.input : ''
  return value ? `写入 ${value.length} 字符` : '写入空内容'
}

function unitRange(input: ToolInput): string {
  const start = number(input, 'startUnit')
  const count = number(input, 'unitCount')
  if (start === null && count === null) return ''
  const first = start ?? 1
  return count === null ? `从第 ${first} 单元` : `第 ${first}–${first + count - 1} 单元`
}

function countLabel(input: ToolInput, key: string, suffix: string): string {
  const values = Array.isArray(input[key]) ? input[key] : []
  return values.length ? `${values.length} ${suffix}` : ''
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

function primitiveSummary(value: unknown): string {
  if (typeof value === 'string') return compact(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function compact(value: string): string {
  return clip(value.replace(/\s+/gu, ' ').trim(), VALUE_MAX_CHARS)
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

function join(...parts: string[]): string {
  return joinWith(' · ', ...parts)
}

function joinWith(separator: string, ...parts: string[]): string {
  return parts.filter(Boolean).join(separator)
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value
}
