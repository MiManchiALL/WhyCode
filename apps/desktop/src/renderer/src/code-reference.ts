import { z } from 'zod'
import type { RightPanelPage } from './right-panel-state.ts'
import { ComposerValue } from './composer-text.ts'

export const MAX_CODE_REFERENCE_CHARS = 256 * 1024
export const MAX_CODE_REFERENCES = 128
export const MAX_CODE_COMMENT = 4000

const referenceInput = z.object({
  workspace: z.string().min(1),
  sshTarget: z.string().min(1).optional(),
  path: z.string().min(1),
  version: z.string().min(1),
  side: z.enum(['L', 'R']).optional(),
  line: z.int().positive(),
  endLine: z.int().positive(),
  startOffset: z.int().nonnegative().optional(),
  text: z.string().min(1),
  comment: z.string().min(1).max(MAX_CODE_COMMENT).optional(),
}).refine(r => r.endLine >= r.line)

const referenceSchema = referenceInput.safeExtend({ id: z.uuid(), pending: z.boolean() })

export type CodeReference = z.infer<typeof referenceSchema>
export type CodeExcerpt = Pick<CodeReference, 'line' | 'endLine' | 'startOffset' | 'text' | 'side'>
export type CodeReferenceInput = z.infer<typeof referenceInput>

function referencesFit(items: readonly CodeReferenceInput[]): boolean {
  return items.length <= MAX_CODE_REFERENCES
    && items.reduce((sum, item) => sum + item.text.length + (item.comment?.length ?? 0), 0) <= MAX_CODE_REFERENCE_CHARS
}

export const storedCodeReferences = z.array(referenceSchema).max(MAX_CODE_REFERENCES).refine(referencesFit)
  .transform(items => items.filter(item => item.pending))

export function draftCodeReference(input: CodeReferenceInput): CodeReference {
  return { ...input, id: crypto.randomUUID(), pending: true }
}

export class ComposerCodeReferences extends ComposerValue<CodeReference[]> {
  constructor() { super([]) }

  add(input: CodeReferenceInput): boolean {
    const current = this.getSnapshot()
    if (!referencesFit([...current, input])) return false
    this.replace([...current, draftCodeReference(input)])
    return true
  }

  remove = (reference: CodeReference): void => { this.replace(this.getSnapshot().filter(item => item.id !== reference.id)) }
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

const REFERENCE_HEADING = '# 代码引用\n\n'
const ITEM_HEADER = new RegExp([
  /## (批注|选区) (\d+)/, /文件：([^\n]+)/, /工作区：([^\n]+?)(?:（SSH ([^\n]+)）)?/,
  /版本：([^\n]+?)(?: · (变更前 \(L\)|变更后 \(R\)))?/, /行号：(\d+)(?:–(\d+))?/, /所选原文：/, /(`{3,})/,
].map(field => field.source).join('\n') + '\n', 'uy')

/** 围栏长于源码中的反引号。批注续行使用 Markdown 引文，内嵌标题仍属于批注。 */
export function codeReferenceMessage(text: string, references: readonly CodeReferenceInput[] = []): string {
  if (!references.length) return text
  const parts = references.map((item, i) => {
    let fenceLength = 3
    for (const match of item.text.matchAll(/`+/gu)) fenceLength = Math.max(fenceLength, match[0].length + 1)
    const fence = '`'.repeat(fenceLength)
    const comment = item.comment?.includes('\n') ? '\n> ' + item.comment.replaceAll('\n', '\n> ') : item.comment
    return [
      `## ${item.comment ? '批注' : '选区'} ${i + 1}`,
      `文件：${item.path}`, `工作区：${item.workspace}${item.sshTarget ? `（SSH ${item.sshTarget}）` : ''}`,
      `版本：${item.version}${item.side ? ` · ${item.side === 'L' ? '变更前 (L)' : '变更后 (R)'}` : ''}`,
      `行号：${lineLabel(item)}`, '所选原文：', fence, item.text, fence,
      ...(comment ? ['批注：' + comment] : []),
    ].join('\n')
  })
  return (text ? text + '\n\n' : '') + REFERENCE_HEADING + parts.join('\n\n')
}

/** 只收起完整的引用后缀。普通正文和未写完的示例按用户输入显示。 */
export function splitCodeReferenceMessage(message: string): { text: string; references: CodeReferenceInput[] } {
  for (let at = message.indexOf(REFERENCE_HEADING); at >= 0; at = message.indexOf(REFERENCE_HEADING, at + REFERENCE_HEADING.length)) {
    if (at > 0 && message.slice(at - 2, at) !== '\n\n') continue
    const references = readReferences(message, at + REFERENCE_HEADING.length)
    if (references) return { text: at ? message.slice(0, at - 2) : '', references }
  }
  return { text: message, references: [] }
}

function readReferences(message: string, at: number): CodeReferenceInput[] | null {
  const nextSection = /\n\n(?=## (?:批注|选区) \d+\n文件：|# 代码引用\n\n## )/gu
  const items: CodeReferenceInput[] = []
  while (at < message.length) {
    ITEM_HEADER.lastIndex = at
    const match = ITEM_HEADER.exec(message)
    if (!match || Number(match[2]) !== items.length + 1 || items.length >= MAX_CODE_REFERENCES) return null
    const [, kind, , path, workspace, sshTarget, version, change, first, last, fence] = match
    const end = message.indexOf('\n' + fence, ITEM_HEADER.lastIndex)
    if (end < 0) return null
    const text = message.slice(ITEM_HEADER.lastIndex, end)
    at = end + 1 + fence!.length
    let comment: string | undefined
    if (kind === '批注') {
      const label = '\n批注：'
      if (!message.startsWith(label, at)) return null
      const start = at + label.length
      nextSection.lastIndex = start
      at = nextSection.exec(message)?.index ?? message.length
      comment = message.slice(start, at)
      if (comment.startsWith('\n> ')) {
        if (/\n(?!> )/u.test(comment)) return null
        comment = comment.slice(3).replaceAll('\n> ', '\n')
      }
    }
    const item = referenceInput.safeParse({ path, workspace, version, line: Number(first), endLine: Number(last ?? first), text,
      ...(sshTarget && { sshTarget }), ...(change && { side: change === '变更前 (L)' ? 'L' : 'R' }),
      ...(kind === '批注' && { comment }) })
    if (!item.success) return null
    items.push(item.data)
    if (at === message.length) return referencesFit(items) ? items : null
    if (!message.startsWith('\n\n## ', at)) return null
    at += 2
  }
  return null
}
