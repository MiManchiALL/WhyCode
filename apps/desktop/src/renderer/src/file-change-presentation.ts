import type { CheckpointFilePreviewState } from '@whycode/core'
import { structuredPatch } from 'diff'

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

export function previewTextState(state: CheckpointFilePreviewState):
  | { ok: true; content: string }
  | { ok: false; message: string } {
  if (state.kind === 'text') return { ok: true, content: state.content }
  if (state.kind === 'missing') return { ok: false, message: '该版本中不存在此文件' }
  return {
    ok: false,
    message: state.reason === 'binary'
      ? '二进制文件不提供文本预览'
      : `文件过大（${formatBytes(state.size)}），不提供内嵌预览`,
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${Math.ceil(bytes / 1_024)} KB`
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
}
