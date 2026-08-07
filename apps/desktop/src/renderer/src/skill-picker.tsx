import { useEffect, useRef } from 'react'
import type { SkillDiagnostic, SkillSummary } from '@whycode/core/skills'
import { Archive, Puzzle, X } from 'lucide-react'
import type { ComposerMenuItem } from './skill-trigger.ts'

const SKILL_SCOPE_LABEL = {
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
          className="max-w-full truncate rounded-lg bg-[var(--wc-blue)] px-1.5 py-0.5 text-[10px] text-[var(--wc-blue-ink)]"
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
  items,
  activeIndex,
  diagnostics,
  limitReached,
  onSelect,
  onActivate,
}: {
  items: readonly ComposerMenuItem[]
  activeIndex: number
  diagnostics: readonly SkillDiagnostic[]
  limitReached: boolean
  onSelect: (item: ComposerMenuItem) => void
  onActivate: (index: number) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-menu-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])
  const indexedItems = items.map((item, index) => ({ item, index }))
  const commandItems = indexedItems.filter(({ item }) => item.kind === 'command')
  const skillItems = indexedItems.filter(({ item }) => item.kind === 'skill')

  return (
    <div
      className="wc-menu-content absolute bottom-full left-0 z-30 mb-2 w-[min(34rem,calc(100vw-2rem))] overflow-hidden p-0"
      role="listbox"
      aria-label="功能与 Skill"
    >
      <div className="border-b border-[var(--wc-line)] px-3 py-2 text-[11px] font-medium text-[var(--wc-faint)]">
        输入筛选，Enter 选择
      </div>
      <div ref={listRef} className="wc-scrollbar max-h-72 overflow-y-auto p-1.5">
        {items.length === 0 ? (
          <div className="px-3 py-5 text-center text-xs text-[var(--wc-faint)]">
            没有匹配的功能或 Skill
          </div>
        ) : (
          <>
            <ComposerMenuGroup
              label="功能"
              entries={commandItems}
              activeIndex={activeIndex}
              limitReached={limitReached}
              onSelect={onSelect}
              onActivate={onActivate}
            />
            <ComposerMenuGroup
              label="Skills"
              entries={skillItems}
              activeIndex={activeIndex}
              limitReached={limitReached}
              onSelect={onSelect}
              onActivate={onActivate}
            />
          </>
        )}
      </div>
      {(diagnostics.length > 0 || limitReached) && (
        <div className="border-t border-[var(--wc-line)] px-3 py-1.5 text-[10px] text-[var(--wc-sand-ink)]">
          {limitReached
            ? '本条消息已达到 8 个 Skill 上限'
            : `${diagnostics.length} 个 Skill 目录项校验未通过`}
        </div>
      )}
    </div>
  )
}

function ComposerMenuGroup(props: {
  label: string
  entries: readonly { item: ComposerMenuItem; index: number }[]
  activeIndex: number
  limitReached: boolean
  onSelect: (item: ComposerMenuItem) => void
  onActivate: (index: number) => void
}) {
  if (props.entries.length === 0) return null
  return (
    <section aria-label={props.label}>
      <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--wc-faint)]">
        {props.label}
      </div>
      {props.entries.map(({ item, index }) => {
        const isCommand = item.kind === 'command'
        const disabled = isCommand ? item.command.disabled : props.limitReached
        const name = isCommand ? item.command.name : item.skill.name
        const description = isCommand ? item.command.description : item.skill.description
        return (
          <button
            key={isCommand ? `command:${item.command.id}` : item.skill.id}
            data-menu-index={index}
            type="button"
            role="option"
            aria-selected={index === props.activeIndex}
            disabled={disabled}
            className={`flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors disabled:opacity-40 ${
              index === props.activeIndex ? 'bg-[var(--wc-blue)]' : 'hover:bg-black/[0.035]'
            }`}
            onMouseEnter={() => props.onActivate(index)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onSelect(item)}
          >
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-[var(--wc-line)] bg-white text-[var(--wc-muted)]">
              {isCommand ? <Archive size={14} /> : <Puzzle size={14} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-medium text-[var(--wc-ink)]">
                {isCommand ? `/${name}` : name}
                {!isCommand && (
                  <span className="rounded-md bg-black/[0.045] px-1.5 py-0.5 text-[9px] font-normal text-[var(--wc-faint)]">
                    {SKILL_SCOPE_LABEL[item.skill.scope]}
                  </span>
                )}
              </span>
              <span className="mt-0.5 block line-clamp-2 text-[11px] leading-4 text-[var(--wc-muted)]">
                {description}
              </span>
            </span>
          </button>
        )
      })}
    </section>
  )
}
