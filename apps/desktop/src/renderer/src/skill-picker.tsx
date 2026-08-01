import { useEffect, useRef } from 'react'
import type { SkillDiagnostic, SkillSummary } from '@whycode/core/skills'

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
          className="max-w-full truncate rounded bg-violet-100 px-1.5 py-0.5 text-[10px] text-violet-700"
          title={skill.path}
        >
          ✦ {skill.name} · {SKILL_SCOPE_LABEL[skill.scope]}
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
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-1 text-xs text-violet-700"
          title={skill.path}
        >
          <span aria-hidden="true">✦</span>
          <span className="truncate">{skill.name}</span>
          <button
            type="button"
            className="rounded px-0.5 text-violet-400 hover:bg-violet-100 hover:text-violet-700 disabled:opacity-40"
            aria-label={`移除 Skill ${skill.name}`}
            disabled={disabled}
            onClick={() => onRemove(skill.id)}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}

export function SkillPicker({
  skills,
  selectedIds,
  activeIndex,
  diagnostics,
  limitReached,
  onSelect,
  onActivate,
}: {
  skills: readonly SkillSummary[]
  selectedIds: ReadonlySet<string>
  activeIndex: number
  diagnostics: readonly SkillDiagnostic[]
  limitReached: boolean
  onSelect: (skill: SkillSummary) => void
  onActivate: (index: number) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-skill-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <div
      className="absolute bottom-full left-20 z-30 mb-2 w-[min(42rem,calc(100%-5rem))] overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-xl"
      role="listbox"
      aria-label="可用 Skill"
    >
      <div className="border-b border-neutral-100 px-3 py-2 text-xs font-medium text-neutral-500">
        Skill · 输入名称筛选，Enter 选择
      </div>
      <div ref={listRef} className="max-h-72 overflow-y-auto p-1">
        {skills.length === 0
          ? (
            <div className="px-3 py-5 text-center text-xs text-neutral-400">
              没有匹配的 Skill
            </div>
          )
          : skills.map((skill, index) => {
            const selected = selectedIds.has(skill.id)
            const disabled = selected || limitReached
            return (
              <button
                key={skill.id}
                data-skill-index={index}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={disabled}
                className={`block w-full rounded px-3 py-2 text-left disabled:opacity-50 ${
                  index === activeIndex ? 'bg-violet-50' : 'hover:bg-neutral-50'
                }`}
                onMouseEnter={() => onActivate(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(skill)}
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium text-neutral-800">{skill.name}</span>
                  <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
                    {SKILL_SCOPE_LABEL[skill.scope]}
                  </span>
                  {selected && <span className="text-[10px] text-violet-500">已选择</span>}
                </span>
                <span className="mt-0.5 block line-clamp-2 text-xs text-neutral-500">
                  {skill.description}
                </span>
                <span className="mt-1 block truncate text-[10px] text-neutral-400">
                  {skill.path}
                </span>
              </button>
            )
          })}
      </div>
      {(diagnostics.length > 0 || limitReached) && (
        <div className="border-t border-neutral-100 px-3 py-1.5 text-[10px] text-amber-700">
          {limitReached
            ? '本条消息已达到 8 个 Skill 上限'
            : `${diagnostics.length} 个 Skill 目录项校验未通过`}
        </div>
      )}
    </div>
  )
}
