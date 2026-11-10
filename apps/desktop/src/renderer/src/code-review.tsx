import { createContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import * as Popover from '@radix-ui/react-popover'
import { Check, MessageSquareText, Plus, X } from 'lucide-react'
import { MAX_CODE_COMMENT, lineLabel, type CodeExcerpt, type CodeReference, type CodeReferenceInput } from './code-reference.ts'
import { CodeCommentMarker } from './code-reference-chips.tsx'
import { codeExcerpt, excerptRow, readCodeRange } from './code-selection.ts'
import type { FileDiffLine } from './file-change-presentation.ts'
import { fileName, filePathKey } from './local-files.ts'
import type { HighlightedLines } from './syntax-highlighting.ts'

export interface CodeReview {
  workspace: string
  sshTarget?: string
  version: string
  items: readonly CodeReference[]
  disabled: boolean
  add: (reference: CodeReferenceInput) => boolean
  remove: (id: string) => void
}
export const CodeReviewContext = createContext<CodeReview | null>(null)

export function CodeReviewSurface({ review, children }: { review: CodeReview | null; children: ReactNode }) {
  const surface = useRef<HTMLDivElement>(null)
  const enabled = review !== null
  useEffect(() => {
    if (!enabled) return
    const clear = (event: PointerEvent) => {
      if (event.button !== 0 || event.shiftKey || !(event.target instanceof Element) || event.target.closest('[data-code-selection-menu]')) return
      const selection = document.getSelection()
      if (!selection || selection.isCollapsed) return
      const node = selection.anchorNode
      const code = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('.wc-code-lines')
      if (code && surface.current?.contains(code)) {
        selection.removeAllRanges()
        delete code.dataset.selectionSide
      }
    }
    document.addEventListener('pointerdown', clear, true)
    return () => document.removeEventListener('pointerdown', clear, true)
  }, [enabled])
  return <CodeReviewContext value={review}><div ref={surface} className="contents">{children}</div></CodeReviewContext>
}

interface ReviewProps {
  review: CodeReview
  path: string
  lines: readonly FileDiffLine[]
  diff: boolean
  body: RefObject<HTMLDivElement | null>
  highlighted: HighlightedLines | null
}

interface SelectionMenu { excerpt: CodeExcerpt; x: number; y: number; height: number }

/** 短选区的浮层避让整个选区。跨屏拖选时跟随松开鼠标的位置。 */
function menuPosition(scroller: HTMLElement, selection: Range, event: PointerEvent) {
  const start = selection.cloneRange(), end = selection.cloneRange()
  start.collapse(true); end.collapse(false)
  const first = start.getBoundingClientRect(), last = end.getBoundingClientRect()
  const bounds = scroller.getBoundingClientRect()
  const visible = first.height > 0 && last.height > 0 && first.top >= Math.max(0, bounds.top)
    && last.bottom <= Math.min(window.innerHeight, bounds.bottom)
  return {
    x: event.clientX - bounds.left + scroller.scrollLeft,
    y: (visible ? first.top : event.clientY) - bounds.top + scroller.scrollTop,
    height: visible ? last.bottom - first.top : 1,
  }
}

export function CodeReviewControls({ review, path, lines, diff, body, highlighted }: ReviewProps) {
  const [menu, setMenu] = useState<SelectionMenu | null>(null)
  const [comment, setComment] = useState<string | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const editing = comment !== null
  useEffect(() => { if (editing) textarea.current?.focus() }, [editing])

  useEffect(() => {
    setMenu(null)
    setComment(null)
    const root = body.current
    if (!root || review.disabled) return
    const doc = root.ownerDocument
    // 链接定位也使用原生选区。只在用户从代码内开始拖选并松开时打开操作菜单。
    const finish = (event: PointerEvent) => {
      cancel()
      const range = readCodeRange(root)
      const excerpt = range && codeExcerpt(lines, range, diff)
      if (!excerpt) { delete root.dataset.selectionSide; return }
      setMenu({ excerpt, ...menuPosition(root.parentElement!, doc.getSelection()!.getRangeAt(0), event) })
    }
    const cancel = () => { doc.removeEventListener('pointerup', finish); doc.removeEventListener('pointercancel', cancel) }
    const begin = (event: PointerEvent) => {
      cancel()
      if (event.button !== 0 || !(event.target instanceof Element) || !event.target.closest('.wc-code-text')) return
      if (diff) root.dataset.selectionSide = event.target.closest<HTMLElement>('[data-tone]')?.dataset.tone === 'removed' ? 'L' : 'R'
      setMenu(null)
      setComment(null)
      doc.addEventListener('pointerup', finish, { once: true })
      doc.addEventListener('pointercancel', cancel, { once: true })
    }
    root.addEventListener('pointerdown', begin)
    return () => { root.removeEventListener('pointerdown', begin); delete root.dataset.selectionSide; cancel() }
  }, [body, lines, diff, path, review.workspace, review.sshTarget, review.version, review.disabled])

  const choosing = menu !== null && !editing
  useEffect(() => {
    if (!choosing) return
    const root = body.current!
    const changed = () => {
      const selection = root.ownerDocument.getSelection()
      if (!selection || selection.isCollapsed || !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) setMenu(null)
    }
    root.ownerDocument.addEventListener('selectionchange', changed)
    return () => root.ownerDocument.removeEventListener('selectionchange', changed)
  }, [body, choosing])

  const notes = useMemo(() => review.items.filter(item => item.comment && filePathKey(item.workspace) === filePathKey(review.workspace)
    && item.sshTarget === review.sshTarget && item.version === review.version && filePathKey(item.path) === filePathKey(path)),
  [review.items, review.workspace, review.sshTarget, review.version, path])
  const close = () => { setMenu(null); setComment(null) }
  const currentExcerpt = () => {
    const range = body.current && readCodeRange(body.current)
    return range && codeExcerpt(lines, range, diff)
  }
  const add = () => {
    if (!menu || review.disabled || editing && !comment.trim()) return
    const excerpt = editing ? menu.excerpt : currentExcerpt()
    if (!excerpt) { close(); return }
    if (review.add({ ...excerpt, workspace: review.workspace, sshTarget: review.sshTarget, path, version: review.version,
      ...(editing ? { comment: comment.trim() } : {}) })) {
      const root = body.current
      if (root && readCodeRange(root)) root.ownerDocument.getSelection()?.removeAllRanges()
      close()
    }
  }
  return <>
    {notes.length > 0 && <GutterNotes notes={notes} lines={lines} body={body} highlighted={highlighted}
      onRemove={review.disabled ? undefined : review.remove} />}
    {menu && <Popover.Root open onOpenChange={open => { if (!open) close() }}>
      <Popover.Anchor asChild><span className="pointer-events-none absolute w-px" style={{ left: menu.x, top: menu.y, height: menu.height }} /></Popover.Anchor>
      <Popover.Portal><Popover.Content data-code-selection-menu="" className={editing ? 'wc-reference-popover wc-reference-editor' : 'wc-code-selection-menu'}
        side="bottom" align="start" sideOffset={6} collisionPadding={8} hideWhenDetached={!editing}
        aria-label={editing ? '添加代码批注' : '代码选区操作'} onOpenAutoFocus={e => e.preventDefault()}
        onCloseAutoFocus={e => e.preventDefault()} onEscapeKeyDown={e => {
          e.preventDefault(); e.stopPropagation(); if (!e.isComposing) close()
        }}>
        {editing ? <form onSubmit={e => { e.preventDefault(); add() }}>
          <div className="flex min-w-0 items-center gap-2 text-xs text-[var(--wc-muted)]"><MessageSquareText size={14} />
            <span className="truncate">{fileName(path)} · {lineLabel(menu.excerpt)}</span>
            <button type="button" className="wc-preview-action ml-auto" aria-label="取消批注" onClick={close}><X size={13} /></button>
          </div>
          <textarea ref={textarea} className="wc-reference-textarea" aria-label="批注内容" placeholder="写下批注…"
            maxLength={MAX_CODE_COMMENT} value={comment} onChange={e => setComment(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); add() }
            }} />
          <div className="flex justify-end"><button className="wc-reference-submit" disabled={!comment.trim()}><Check size={14} />保存批注</button></div>
        </form> : <>
          <button type="button" className="wc-focus-ring" onMouseDown={e => e.preventDefault()} onClick={add}><Plus size={14} />添加到对话</button>
          <button type="button" className="wc-focus-ring" onMouseDown={e => e.preventDefault()} onClick={() => {
            const excerpt = currentExcerpt()
            if (excerpt) { setMenu({ ...menu, excerpt }); setComment('') }
          }}><MessageSquareText size={13} />批注</button>
        </>}
      </Popover.Content></Popover.Portal>
    </Popover.Root>}
  </>
}

function GutterNotes({ notes, lines, body, highlighted, onRemove }: Pick<ReviewProps, 'lines' | 'body' | 'highlighted'> & {
  notes: CodeReference[]; onRemove?: (id: string) => void
}) {
  const [anchors, setAnchors] = useState<Map<HTMLElement, CodeReference[]>>(new Map())
  // 高亮器替换静态行节点后重新取得行号槽。批注开合与增删本身不会重建代码 DOM。
  useEffect(() => {
    const next = new Map<HTMLElement, CodeReference[]>()
    for (const note of notes) {
      const row = excerptRow(lines, note)
      if (row === null) continue
      const gutter = body.current?.querySelector<HTMLElement>(`[data-code-row="${row}"] > .wc-code-line-number`)
      if (!gutter) continue
      const existing = next.get(gutter)
      if (existing) existing.push(note)
      else next.set(gutter, [note])
    }
    setAnchors(next)
  }, [notes, lines, body, highlighted])
  return [...anchors].map(([anchor, items]) => createPortal(
    <CodeCommentMarker items={items} gutter onRemove={onRemove} />, anchor, items[0]!.id,
  ))
}
