import type { SkillSummary } from '@whycode/core/skills'
import type { Block, ToolCall } from './conversation-state.ts'
import type { ConversationDisplayItem } from './conversation-btw-groups.ts'
import {
  summarizeToolCallParts,
  toolCallFilePaths,
} from './tool-call-summary.ts'

export type ToolBlock = Extract<Block, { kind: 'tool' }>

export interface ToolBatch {
  id: string
  tools: ToolBlock[]
}

export interface ToolBatchSegment {
  kind: 'tool-segment'
  id: string
  blocks: readonly Block[]
  batch: ToolBatch
  sealed: boolean
}

export type ToolBatchPresentationItem =
  | { kind: 'block'; id: string; block: Block }
  | ToolBatchSegment

export type ConversationToolBatchDisplayItem =
  | ConversationDisplayItem
  | ToolBatchSegment

export type ToolSegmentContentItem =
  | { kind: 'block'; id: string; block: Block }
  | { kind: 'tool-batch'; id: string; batch: ToolBatch }

export type ToolBatchCategory = 'files' | 'command' | 'other'

export interface ToolBatchSummary {
  label: string
  icon: ToolBatchCategory
}

export interface ToolBatchRow {
  id: string
  call: ToolCall
  summary: string
  fullPath?: string
  added?: number
  removed?: number
  checkpointAnchor: boolean
}

const FILE_TOOL_NAMES = new Set(['WriteFile', 'EditFile', 'DeleteFile'])

/**
 * 文本是工具批次的提交边界：只有后续文本已经出现，前一段工具才折叠。
 * trailingToolsSealed 用于最终正文已被 WorkSection 单独投影的情况。
 */
export function presentToolBatches(
  blocks: readonly Block[],
  trailingToolsSealed = false,
): ToolBatchPresentationItem[] {
  const presented: ToolBatchPresentationItem[] = []
  let segment: Block[] = []

  const flush = (sealed: boolean) => {
    appendSegment(presented, segment, sealed)
    segment = []
  }

  for (const block of blocks) {
    if (block.kind === 'user' || block.kind === 'work-duration') {
      flush(false)
      presented.push({ kind: 'block', id: block.id, block })
      continue
    }
    if (block.kind === 'text') {
      flush(true)
      presented.push({ kind: 'block', id: block.id, block })
      continue
    }
    segment.push(block)
  }
  flush(trailingToolsSealed)
  return presented
}

/** 顶层尚未形成 WorkSection 的原始块也使用相同文本边界规则。 */
export function presentConversationToolBatches(
  items: readonly ConversationDisplayItem[],
): ConversationToolBatchDisplayItem[] {
  const result: ConversationToolBatchDisplayItem[] = []
  let blocks: Block[] = []

  const flush = () => {
    for (const item of presentToolBatches(blocks)) {
      result.push(item.kind === 'tool-segment'
        ? item
        : {
            kind: 'section',
            id: item.id,
            section: { kind: 'block', id: item.id, block: item.block },
          })
    }
    blocks = []
  }

  for (const item of items) {
    if (item.kind === 'section' && item.section.kind === 'block') {
      blocks.push(item.section.block)
      continue
    }
    flush()
    result.push(item)
  }
  flush()
  return result
}

/**
 * ToolSegment 最终渲染顺序的纯投影。未封口时保留每张工具卡；封口后只保留
 * 第一处批次摘要，再按此时真正可见的顺序合并相邻思考。
 */
export function presentToolSegmentContent(
  segment: ToolBatchSegment,
  sealed: boolean,
): ToolSegmentContentItem[] {
  const result: ToolSegmentContentItem[] = []
  let renderedBatch = false

  for (const block of segment.blocks) {
    if (sealed && block.kind === 'tool') {
      if (!renderedBatch) {
        result.push({ kind: 'tool-batch', id: segment.batch.id, batch: segment.batch })
        renderedBatch = true
      }
      continue
    }
    appendVisibleBlock(result, block)
  }
  return result
}

export function summarizeToolBatch(batch: ToolBatch): ToolBatchSummary {
  const categories = new Set<ToolBatchCategory>()
  for (const { call } of batch.tools) categories.add(toolCategory(call.name))

  const hasFiles = categories.has('files')
  const hasCommand = categories.has('command')
  const hasOther = categories.has('other')
  let label: string
  if (hasFiles && hasCommand && hasOther) label = '编辑了文件运行了命令并调用了工具'
  else if (hasFiles && hasCommand) label = '编辑了文件并运行了命令'
  else if (hasFiles && hasOther) label = '编辑了文件并调用了工具'
  else if (hasCommand && hasOther) label = '运行了命令并调用了工具'
  else if (hasFiles) label = '编辑了文件'
  else if (hasCommand) label = '运行了命令'
  else label = '调用了工具'

  return {
    label,
    icon: hasFiles ? 'files' : hasCommand ? 'command' : 'other',
  }
}

export function toolBatchRows(
  batch: ToolBatch,
  context: {
    skills: readonly SkillSummary[]
    projectDir: string | null
    checkpointRestoreAnchorIds: ReadonlySet<string>
  },
): ToolBatchRow[] {
  return batch.tools.flatMap(({ call }) => {
    const paths = FILE_TOOL_NAMES.has(call.name) ? toolCallFilePaths(call.name, call.input) : []
    if (paths.length === 0) {
      return [{
        id: `${batch.id}:row:${call.id}`,
        call,
        summary: toolSummary(call, context),
        checkpointAnchor: context.checkpointRestoreAnchorIds.has(call.id),
      }]
    }

    const changes = new Map(
      call.fileChanges?.map((change) => [pathKey(change.path), change] as const) ?? [],
    )
    return paths.map((path, index) => {
      const change = changes.get(pathKey(path))
      return {
        id: `${batch.id}:row:${call.id}:${index}`,
        call,
        summary: fileName(path),
        fullPath: resolveDisplayPath(path, context.projectDir),
        ...(change ? { added: change.added, removed: change.removed } : {}),
        checkpointAnchor: index === 0 && context.checkpointRestoreAnchorIds.has(call.id),
      }
    })
  })
}

export function toolCategory(toolName: string): ToolBatchCategory {
  if (FILE_TOOL_NAMES.has(toolName)) return 'files'
  return toolName === 'RunCommand' ? 'command' : 'other'
}

function appendSegment(
  target: ToolBatchPresentationItem[],
  blocks: readonly Block[],
  sealed: boolean,
): void {
  const tools = blocks.filter((block): block is ToolBlock => block.kind === 'tool')
  if (tools.length === 0) {
    for (const block of mergeAdjacentThinkingBlocks(blocks)) {
      target.push({ kind: 'block', id: block.id, block })
    }
    return
  }

  const firstToolId = tools[0]!.call.id
  const id = `tool-batch-${firstToolId}`
  target.push({
    kind: 'tool-segment',
    id,
    blocks: [...blocks],
    batch: { id, tools },
    sealed,
  })
}

function appendVisibleBlock(target: ToolSegmentContentItem[], block: Block): void {
  const last = target.at(-1)
  if (
    last?.kind === 'block'
    && last.block.kind === 'thinking'
    && block.kind === 'thinking'
  ) {
    last.block = mergeThinkingBlocks(last.block, block)
    return
  }
  target.push({ kind: 'block', id: block.id, block })
}

function mergeAdjacentThinkingBlocks(blocks: readonly Block[]): Block[] {
  const result: Block[] = []
  for (const block of blocks) {
    const last = result.at(-1)
    if (last?.kind === 'thinking' && block.kind === 'thinking') {
      result[result.length - 1] = mergeThinkingBlocks(last, block)
    } else {
      result.push(block)
    }
  }
  return result
}

function mergeThinkingBlocks(
  first: Extract<Block, { kind: 'thinking' }>,
  next: Extract<Block, { kind: 'thinking' }>,
): Extract<Block, { kind: 'thinking' }> {
  return {
    ...first,
    text: appendThinkingText(first.text, next.text),
    durationMs: first.durationMs === null || next.durationMs === null
      ? null
      : first.durationMs + next.durationMs,
  }
}

function appendThinkingText(current: string, next: string): string {
  if (!current || !next || current.endsWith('\n') || next.startsWith('\n')) {
    return current + next
  }
  return `${current}\n\n${next}`
}

function toolSummary(
  call: ToolCall,
  context: { skills: readonly SkillSummary[]; projectDir: string | null },
): string {
  const summary = summarizeToolCallParts(call.name, call.input, {
    result: call.result,
    skills: context.skills,
    projectDir: context.projectDir,
  })
  return [summary.primary, summary.trailing].filter(Boolean).join(' · ')
}

function pathKey(path: string): string {
  return path.replaceAll('\\', '/')
}

function fileName(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const lastSeparator = normalized.lastIndexOf('/')
  return normalized.slice(lastSeparator + 1) || path
}

function resolveDisplayPath(path: string, projectDir: string | null): string {
  if (!projectDir || isAbsolutePath(path)) return path

  const separator = projectDir.includes('\\') ? '\\' : '/'
  const normalizedBase = projectDir.replaceAll('\\', '/')
  const normalizedPath = path.replaceAll('\\', '/')
  const drive = normalizedBase.match(/^([A-Za-z]:)\//u)?.[1] ?? ''
  const unc = normalizedBase.startsWith('//')
  const rooted = normalizedBase.startsWith('/')
  const prefix = drive ? `${drive}/` : unc ? '//' : rooted ? '/' : ''
  const baseWithoutRoot = normalizedBase.slice(prefix.length)
  const parts = baseWithoutRoot.split('/').filter(Boolean)
  const protectedParts = unc ? Math.min(2, parts.length) : 0

  for (const part of normalizedPath.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length > protectedParts) parts.pop()
      continue
    }
    parts.push(part)
  }

  return `${prefix}${parts.join('/')}`.replaceAll('/', separator)
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || /^[\\/]{2}/u.test(path) || path.startsWith('/')
}
