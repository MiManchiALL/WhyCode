import { Code2, MessageSquareText, Trash2 } from 'lucide-react'
import * as Popover from '@radix-ui/react-popover'
import { ReferenceChip } from './reference-chip.tsx'
import { lineLabel, type CodeReference, type CodeReferenceInput } from './code-reference.ts'
import { displayFilePath } from './local-files.ts'

function CodeReferenceDetails<T extends CodeReferenceInput>({ items, onRemove }: {
  items: readonly T[]; onRemove?: (item: T) => void
}) {
  return items.map((item, index) => <div key={index} className="wc-code-reference-detail">
    <div className="flex min-w-0 items-center gap-1.5 text-xs">
      <Code2 size={14} className="shrink-0 text-[var(--wc-blue-ink)]" />
      <span className="min-w-0 flex-1 truncate font-medium" title={item.path}>{displayFilePath(item.path, item.workspace)}</span>
      <span className="shrink-0 text-[var(--wc-muted)]" title={`${item.sshTarget ? `SSH ${item.sshTarget} · ` : ''}${item.workspace} · ${item.version}`}>{item.side} {lineLabel(item)}</span>
      {onRemove && <button type="button" className="wc-preview-action" aria-label="移除代码引用" title="移除"
        onClick={() => onRemove(item)}><Trash2 size={13} /></button>}
    </div>
    {item.comment && <p className="mt-1 whitespace-pre-wrap break-words text-sm">{item.comment}</p>}
    <pre className="wc-code-excerpt wc-scrollbar">{item.text}</pre>
  </div>)
}

export function CodeReferenceChips<T extends CodeReferenceInput>({ items, onRemove }: { items?: readonly T[]; onRemove?: (item: T) => void }) {
  if (!items?.length) return null
  const selections = items.filter(item => !item.comment), comments = items.filter(item => item.comment)
  return <div className="flex max-w-full flex-wrap items-center gap-1.5">
    {selections.length > 0 && <ReferenceChip name="选中代码" count={selections.length} unit="段" icon={Code2}>
      <CodeReferenceDetails items={selections} onRemove={onRemove} />
    </ReferenceChip>}
    {comments.length > 0 && <ReferenceChip name="代码批注" count={comments.length} icon={MessageSquareText}>
      <CodeReferenceDetails items={comments} onRemove={onRemove} />
    </ReferenceChip>}
  </div>
}

export function CodeCommentMarker({ items, gutter, onRemove }: {
  items: CodeReference[]; gutter?: boolean; onRemove?: (item: CodeReference) => void
}) {
  if (!items.length) return null
  const label = `${gutter ? '第 ' + items[0]!.line + ' 行' : '待发送的代码批注'} · ${items.length} 条批注`
  return <Popover.Root>
    <Popover.Trigger asChild><button type="button" className={gutter ? 'wc-code-note-marker wc-focus-ring' : 'wc-preview-action'}
      aria-label={label} title={label}><MessageSquareText size={gutter ? 13 : 15} /></button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="wc-reference-popover wc-reference-list wc-scrollbar max-h-80 overflow-y-auto"
      aria-label={gutter ? '行内批注' : '待发送的代码批注'} side="bottom" align={gutter ? 'start' : 'end'} sideOffset={5}
      collisionPadding={8} onOpenAutoFocus={e => e.preventDefault()}>
      <CodeReferenceDetails items={items} onRemove={onRemove} />
    </Popover.Content></Popover.Portal>
  </Popover.Root>
}
