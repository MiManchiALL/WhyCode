import { z } from 'zod'
import type { RightPanelPage } from './right-panel-state.ts'
import { ComposerValue } from './composer-text.ts'

export const MAX_CODE_REFERENCE_CHARS = 256 * 1024
export const MAX_CODE_REFERENCES = 128
export const MAX_CODE_COMMENT = 4000

const referenceSchema = z.object({
  id: z.uuid(),
  workspace: z.string().min(1),
  sshTarget: z.string().min(1).optional(),
  path: z.string().min(1),
  version: z.string().min(1),
  side: z.enum(['L', 'R']).optional(),
  line: z.int().positive(),
  endLine: z.int().positive(),
  startOffset: z.int().nonnegative(),
  endOffset: z.int().nonnegative(),
  text: z.string().min(1),
  comment: z.string().min(1).max(MAX_CODE_COMMENT).optional(),
  pending: z.boolean(),
}).refine(r => r.endLine >= r.line && (r.pending || r.comment !== undefined))

export type CodeReference = z.infer<typeof referenceSchema>
export type CodeExcerpt = Pick<CodeReference, 'line' | 'endLine' | 'startOffset' | 'endOffset' | 'text' | 'side'>
export type CodeReferenceInput = Omit<CodeReference, 'id' | 'pending'>

function referencesFit(items: readonly CodeReferenceInput[]): boolean {
  return items.length <= MAX_CODE_REFERENCES
    && items.reduce((sum, item) => sum + item.text.length + (item.comment?.length ?? 0), 0) <= MAX_CODE_REFERENCE_CHARS
}

export const storedCodeReferences = z.array(referenceSchema).max(MAX_CODE_REFERENCES).refine(referencesFit)

export class ComposerCodeReferences extends ComposerValue<CodeReference[]> {
  constructor() { super([]) }

  add(input: CodeReferenceInput): boolean {
    const current = this.getSnapshot()
    if (!referencesFit([...current, input])) return false
    this.replace([...current, { ...input, id: crypto.randomUUID(), pending: true }])
    return true
  }

  remove = (id: string): void => { this.replace(this.getSnapshot().filter(item => item.id !== id)) }
}

export function lineLabel({ line, endLine }: Pick<CodeExcerpt, 'line' | 'endLine'>): string {
  return line === endLine ? String(line) : `${line}–${endLine}`
}

export function codePreviewVersion(page: RightPanelPage | null): string | undefined {
  switch (page?.kind) {
    case 'file': return page.source.kind === 'current' ? '当前文件' : `${page.source.toolName} 操作后快照（${page.source.toolUseId}）`
    case 'changes': {
      const ids = page.checkpointIds
      const range = ids.length === 1 ? ids[0] : `${ids[0]} … ${ids.at(-1)}`
      return `本轮文件差异（${range}）`
    }
    case 'git':
      if (page.mode === 'branch') return `Git 分支差异（${page.baseRef ?? '默认基准'}）`
      if (page.mode === 'commit') return `Git 提交 ${page.commit}`
      return { staged: 'Git 已暂存差异', unstaged: 'Git 未暂存差异', uncommitted: 'Git 未提交差异' }[page.mode]
  }
}

/** 提交时摘录成为用户正文。围栏长于原文中的反引号，保留首尾空白及嵌套代码。 */
export function codeReferenceMessage(text: string, references: readonly CodeReference[] = []): string {
  const pending = references.filter(item => item.pending)
  if (!pending.length) return text
  const parts = pending.map((item, i) => {
    let fenceLength = 3
    for (const match of item.text.matchAll(/`+/gu)) fenceLength = Math.max(fenceLength, match[0].length + 1)
    const fence = '`'.repeat(fenceLength)
    return [
      `## ${item.comment ? '批注' : '选区'} ${i + 1}`,
      `文件：${item.path}`, `工作区：${item.workspace}${item.sshTarget ? `（SSH ${item.sshTarget}）` : ''}`,
      `版本：${item.version}${item.side ? ` · ${item.side === 'L' ? '变更前 (L)' : '变更后 (R)'}` : ''}`,
      `行号：${lineLabel(item)}`, '所选原文：', fence, item.text, fence,
      ...(item.comment ? [`批注：${item.comment}`] : []),
    ].join('\n')
  })
  return [text, '# 代码引用', ...parts].filter(Boolean).join('\n\n')
}

/** 从待发送输入取走选区，批注仍由所属会话持有。 */
export function retainedCodeComments(items: readonly CodeReference[]): CodeReference[] {
  return items.filter(item => item.comment).map(item => item.pending ? { ...item, pending: false } : item)
}

export function restoreCodeReferences(sent: readonly CodeReference[], current: readonly CodeReference[]): CodeReference[] {
  const ids = new Set(sent.map(item => item.id))
  return [...sent, ...current.filter(item => !ids.has(item.id))]
}
