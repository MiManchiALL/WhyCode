import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SubagentSummary } from '@whycode/core'
import { Bot, FileText, FolderOpen, SquareTerminal, X } from 'lucide-react'
import {
  closestCenter, defaultDropAnimationSideEffects, DndContext, DragOverlay,
  KeyboardSensor, PointerSensor, useSensor, useSensors,
} from '@dnd-kit/core'
import { horizontalListSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { RightPanelTab } from './right-panel-state.ts'
import { resolveSubagentPanelPage } from './subagent-presentation.ts'

interface Props {
  tabs: readonly RightPanelTab[]
  activeTabId: string | null
  subagents: readonly SubagentSummary[]
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onMove: (id: string, targetId: string) => void
  children: ReactNode
}

export function RightPanelTabs(props: Props) {
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  )
  const dragged = props.tabs.find(tab => tab.id === draggedId)
  const titleFor = (id: string | number) => {
    const tab = props.tabs.find(tab => tab.id === id)
    return tab ? tabTitle(tab, props.subagents) : '标签'
  }
  return <DndContext sensors={sensors} collisionDetection={closestCenter}
    autoScroll={{ canScroll: element => element === scrollRef.current }}
    accessibility={{
      screenReaderInstructions: { draggable: '按空格拿起标签，左右方向键调整位置，再按空格或回车放下，Esc 取消。' },
      announcements: {
        onDragStart: ({ active }) => `已拿起 ${titleFor(active.id)}`,
        onDragOver: ({ over }) => over ? `移动到第 ${props.tabs.findIndex(tab => tab.id === over.id) + 1} 个位置` : undefined,
        onDragEnd: ({ active }) => `已放下 ${titleFor(active.id)}`,
        onDragCancel: () => '已取消排序',
      },
    }}
    onDragStart={({ active }) => setDraggedId(String(active.id))}
    onDragCancel={() => setDraggedId(null)}
    onDragEnd={({ active, over }) => {
      setDraggedId(null)
      if (over && active.id !== over.id) props.onMove(String(active.id), String(over.id))
    }}>
    <div ref={scrollRef} aria-label="右侧栏页面" className="wc-right-panel-tabs wc-scrollbar min-w-0 flex-1 overflow-x-auto">
      <div className="flex min-w-max items-center gap-1">
        <SortableContext items={props.tabs.map(tab => tab.id)} strategy={horizontalListSortingStrategy}>
          {props.tabs.map(tab => <SortableTab key={tab.id} tab={tab}
            title={tabTitle(tab, props.subagents)} active={tab.id === props.activeTabId}
            onSelect={() => props.onSelect(tab.id)} onClose={() => props.onClose(tab.id)} />)}
        </SortableContext>
        {props.children}
      </div>
    </div>
    {createPortal(<DragOverlay adjustScale={false} zIndex={90} dropAnimation={
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ? null : {
        duration: 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
        sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' } } }),
      }
    }>{dragged ? <div aria-hidden className="wc-panel-tab wc-panel-tab-dragging">
      <TabLabel tab={dragged} title={tabTitle(dragged, props.subagents)} /><X size={12} className="mx-1 shrink-0 text-[var(--wc-faint)]" />
    </div> : null}</DragOverlay>, document.body)}
  </DndContext>
}

function SortableTab({ tab, title, active, onSelect, onClose }: {
  tab: RightPanelTab
  title: string
  active: boolean
  onSelect: () => void
  onClose: () => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id, transition: { duration: 200, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
  })
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (active) buttonRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])
  return <div ref={setNodeRef} data-panel-tab={tab.id} className="wc-panel-tab group" data-active={active}
    style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0 : undefined }}>
    <button type="button" ref={node => { buttonRef.current = node; setActivatorNodeRef(node) }}
      {...attributes} {...listeners} aria-current={active ? 'page' : undefined}
      className="wc-focus-ring flex min-w-0 flex-1 touch-none items-center gap-1 overflow-hidden rounded-md text-left"
      title={tab.page.kind === 'terminal' ? `${title}\n${tab.page.terminal.cwd}` : title} onClick={onSelect}>
      <TabLabel tab={tab} title={title} />
    </button>
    <button type="button" className="wc-focus-ring ml-auto flex size-5 shrink-0 items-center justify-center rounded-md text-[var(--wc-faint)] opacity-70 hover:bg-black/[0.06] hover:text-[var(--wc-ink)] group-hover:opacity-100"
      onClick={onClose} aria-label={`关闭 ${title}`}><X size={12} /></button>
  </div>
}

function TabLabel({ tab, title }: { tab: RightPanelTab; title: string }) {
  const Icon = tab.page.kind === 'file' ? FileText : tab.page.kind === 'terminal' ? SquareTerminal
    : tab.page.kind === 'workspace' ? FolderOpen : Bot
  return <><Icon size={13} className="shrink-0 text-[var(--wc-muted)]" /><span className="truncate">{title}</span></>
}

function tabTitle(tab: RightPanelTab, subagents: readonly SubagentSummary[]): string {
  const page = tab.page
  if (page.kind === 'workspace') return '当前工作路径'
  if (page.kind === 'file') return page.name
  if (page.kind === 'terminal') return page.terminal.title
  return resolveSubagentPanelPage(page, subagents)?.title ?? '子代理'
}
