import { useLayoutEffect, useRef } from 'react'
import type { SkillDiagnostic, SkillSummary } from '@whycode/core/skills'
import { Archive, GitBranch, MessageCircle, Plug, Puzzle, X } from 'lucide-react'
import type { ComposerCommandId, ComposerMenuItem } from './skill-trigger.ts'

const COMMAND_ICONS = { mcp: Plug, compact: Archive, fork: GitBranch, btw: MessageCircle, bbtw: MessageCircle } satisfies Record<ComposerCommandId, typeof Plug>

export const SKILL_SCOPE_LABEL = {
  project: '项目',
  user: '用户',
  system: '内置',
} satisfies Record<SkillSummary['scope'], string>

export function SkillBadges({ skills }: { skills?: readonly SkillSummary[] }) {
  if (!skills?.length) return null
  return (
    <div className="mb-1 flex flex-wrap gap-1" aria-label="消息使用的 Skill">
      {skills.map((skill) => (
        <span
          key={skill.id}
          className="max-w-full truncate rounded-lg bg-[var(--wc-blue)] px-1.5 py-0.5 wc-type-tiny text-[var(--wc-blue-ink)]"
          title={skill.path}
        >
          {skill.name} · {SKILL_SCOPE_LABEL[skill.scope]}
        </span>
      ))}
    </div>
  )
}

export function SkillChips({
  skills,
  disabled,
  onRemove,
}: {
  skills: readonly SkillSummary[]
  disabled: boolean
  onRemove: (id: string) => void
}) {
  if (skills.length === 0) return null
  return (
    <div className="mb-2 flex flex-wrap gap-1.5" aria-label="已选择的 Skill">
      {skills.map((skill) => (
        <span
          key={skill.id}
          className="inline-flex max-w-full items-center gap-1.5 rounded-xl border border-[var(--wc-line)] bg-[var(--wc-blue)] px-2 py-1 text-xs text-[var(--wc-blue-ink)]"
          title={skill.path}
        >
          <Puzzle size={12} aria-hidden="true" />
          <span className="truncate">{skill.name}</span>
          <button
            type="button"
            className="wc-focus-ring rounded-md p-0.5 text-[var(--wc-faint)] hover:bg-black/[0.05] hover:text-[var(--wc-ink)] disabled:opacity-40"
            aria-label={`移除 Skill ${skill.name}`}
            disabled={disabled}
            onClick={() => onRemove(skill.id)}
          >
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  )
}

export function ComposerSlashMenu({
  id,
  items,
  activeIndex,
  diagnostics,
  loading,
  limitReached,
  onSelect,
  onActivate,
}: {
  id: string
  items: readonly ComposerMenuItem[]
  activeIndex: number
  diagnostics: readonly SkillDiagnostic[]
  loading: boolean
  limitReached: boolean
  onSelect: (item: ComposerMenuItem) => void
  onActivate: (index: number) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    const active = list?.querySelector<HTMLElement>(`[data-menu-index="${activeIndex}"]`)
    if (!list || !active) return
    // 只移动选项列表，避免 scrollIntoView 连带滚动输入框和会话外壳。
    const bounds = list.getBoundingClientRect()
    const item = active.getBoundingClientRect()
    if (item.top < bounds.top) list.scrollTop += item.top - bounds.top
    else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom
  }, [activeIndex, items])
  const indexedItems = items.map((item, index) => ({ item, index }))
  const commandItems = indexedItems.filter(({ item }) => item.kind === 'command')
  const skillItems = indexedItems.filter(({ item }) => item.kind === 'skill')

  return (
    <div
      className="wc-slash-menu wc-menu-content"
    >
      <div ref={listRef} id={id} role="listbox" aria-label="功能与 Skill" className="wc-slash-options wc-scrollbar">
        {items.length === 0 && !loading ? (
          <div className="px-3 py-5 text-center text-xs text-[var(--wc-faint)]">
            没有匹配的功能或 Skill
          </div>
        ) : (
          <>
            <ComposerMenuGroup
              id={id}
              label="功能"
              showLabel={false}
              entries={commandItems}
              activeIndex={activeIndex}
              limitReached={limitReached}
              onSelect={onSelect}
              onActivate={onActivate}
            />
            <ComposerMenuGroup
              id={id}
              label="Skills"
              showLabel
              entries={skillItems}
              activeIndex={activeIndex}
              limitReached={limitReached}
              onSelect={onSelect}
              onActivate={onActivate}
            />
          </>
        )}
      </div>
      <div className="wc-slash-hint" aria-hidden="true">↑↓ 选择 <span>Enter 确认</span> <span>Esc 关闭</span></div>
      {(loading || diagnostics.length > 0 || limitReached) && (
        <div
          role="status"
          aria-label="Skill 目录提示"
          className="wc-scrollbar max-h-24 space-y-1 overflow-y-auto border-t border-[var(--wc-line)] px-3 py-1.5 wc-type-tiny text-[var(--wc-sand-ink)] [overflow-wrap:anywhere]"
        >
          {limitReached && <p>本条消息已达到 8 个 Skill 上限</p>}
          {loading ? (
            <p className="text-[var(--wc-muted)]">正在读取 Skill…</p>
          ) : diagnostics.map((diagnostic, index) => (
            <p key={`${diagnostic.path}:${index}`}>
              {diagnostic.message}
              {diagnostic.path && (
                <span className="block text-[var(--wc-faint)]">{diagnostic.path}</span>
              )}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

function ComposerMenuGroup(props: {
  id: string
  label: string
  showLabel: boolean
  entries: readonly { item: ComposerMenuItem; index: number }[]
  activeIndex: number
  limitReached: boolean
  onSelect: (item: ComposerMenuItem) => void
  onActivate: (index: number) => void
}) {
  if (props.entries.length === 0) return null
  return (
    <div role="group" aria-label={props.label}>
      {props.showLabel && <div className="wc-slash-group-label">{props.label}</div>}
      {props.entries.map(({ item, index }) => {
        const isCommand = item.kind === 'command'
        const disabled = isCommand ? item.command.disabled : props.limitReached
        const name = isCommand ? item.command.name : item.skill.name
        const description = isCommand ? item.command.description : item.skill.description
        const Icon = isCommand ? COMMAND_ICONS[item.command.id] : Puzzle
        return (
          <button
            key={isCommand ? `command:${item.command.id}` : item.skill.id}
            id={`${props.id}-${index}`}
            data-menu-index={index}
            type="button"
            role="option"
            tabIndex={-1}
            aria-selected={index === props.activeIndex}
            disabled={disabled}
            title={`${name}\n${description}${isCommand ? '' : `\n${item.skill.path}`}`}
            className="wc-slash-option"
            onPointerMove={event => {
              if (!disabled && event.pointerType !== 'touch' && (event.movementX || event.movementY)) props.onActivate(index)
            }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onSelect(item)}
          >
            <Icon size={16} className="wc-slash-icon" aria-hidden="true" />
            <span className="wc-slash-copy">
              <span className="wc-slash-name">{name}</span>
              <span className="wc-slash-description">{description}</span>
            </span>
            {!isCommand && <span className="wc-slash-scope">{SKILL_SCOPE_LABEL[item.skill.scope]}</span>}
          </button>
        )
      })}
    </div>
  )
}
