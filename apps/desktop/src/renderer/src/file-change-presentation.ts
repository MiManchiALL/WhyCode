import { structuredPatch } from 'diff'
import type { Block } from './conversation-state.ts'

export interface FileChangeSummary {
  path: string
  name: string
  added: number
  removed: number
}

export interface FileDiffLine {
  id: string
  kind: 'context' | 'added' | 'removed'
  text: string
  oldLine: number | null
  newLine: number | null
}

export interface FileDiffHunk {
  id: string
  oldStart: number
  newStart: number
  lines: FileDiffLine[]
}

const PREVIEWED_FILE_TOOLS = new Set(['WriteFile', 'EditFile', 'DeleteFile'])

/** 当前 turn 从最近一条主对话用户消息开始；工作结束后摘要随即消失。 */
export function currentWorkFileChanges(blocks: readonly Block[]): FileChangeSummary[] {
  let boundary = -1
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]!
    if (block.kind === 'work-duration' || (block.kind === 'user' && !block.btw)) {
      boundary = index + 1
      break
    }
  }
  const changes = new Map<string, FileChangeSummary>()
  for (let index = Math.max(0, boundary); index < blocks.length; index++) {
    const block = blocks[index]!
    if (
      block.kind !== 'tool'
      || block.call.status !== 'done'
      || !PREVIEWED_FILE_TOOLS.has(block.call.name)
    ) continue
    for (const change of block.call.fileChanges ?? []) {
      const key = pathKey(change.path)
      const previous = changes.get(key)
      changes.set(key, {
        path: previous?.path ?? change.path,
        name: previous?.name ?? fileName(change.path),
        added: (previous?.added ?? 0) + change.added,
        removed: (previous?.removed ?? 0) + change.removed,
      })
    }
  }
  return [...changes.values()]
}

/** 与 Claude Code 一致保留三行上下文，并把不相邻修改拆成独立 hunk。 */
export function buildFileDiffHunks(
  before: string,
  after: string,
  context = 3,
): FileDiffHunk[] {
  const patch = structuredPatch('', '', before, after, undefined, undefined, {
    context,
    timeout: 300,
  })
  if (!patch) return []
  return patch.hunks.map((hunk, hunkIndex) => {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    const lines: FileDiffLine[] = []
    for (const [lineIndex, rawLine] of hunk.lines.entries()) {
      const prefix = rawLine[0]
      if (prefix === '\\') continue
      const kind = prefix === '+' ? 'added' : prefix === '-' ? 'removed' : 'context'
      lines.push({
        id: `${hunkIndex}:${lineIndex}`,
        kind,
        text: rawLine.slice(1),
        oldLine: kind === 'added' ? null : oldLine,
        newLine: kind === 'removed' ? null : newLine,
      })
      if (kind !== 'added') oldLine++
      if (kind !== 'removed') newLine++
    }
    return {
      id: `${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`,
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      lines,
    }
  })
}

export function firstChangedLine(before: string, after: string): number | null {
  const first = buildFileDiffHunks(before, after, 0)[0]
  if (!first) return null
  const added = first.lines.find((line) => line.kind === 'added')
  return added?.newLine ?? first.newStart
}

export function contentLines(
  content: string,
  kind: FileDiffLine['kind'] = 'context',
): FileDiffLine[] {
  if (content.length === 0) return []
  const normalized = content.replaceAll('\r\n', '\n')
  const sourceLines = normalized.split('\n')
  if (normalized.endsWith('\n')) sourceLines.pop()
  return sourceLines.map((text, index) => ({
    id: String(index),
    kind,
    text,
    oldLine: kind === 'added' ? null : index + 1,
    newLine: kind === 'removed' ? null : index + 1,
  }))
}

function pathKey(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return /^[A-Za-z]:\//u.test(normalized) ? normalized.toLowerCase() : normalized
}

function fileName(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || path
}
