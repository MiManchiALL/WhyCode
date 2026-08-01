import type { SkillSummary } from '@whycode/core/skills'

export interface SkillTrigger {
  start: number
  end: number
  query: string
}

/** `$name` 只在输入边界触发，避免普通金额、变量名和行内文本误开目录。 */
export function findSkillTrigger(text: string, cursor: number | null): SkillTrigger | null {
  if (cursor === null || cursor < 0 || cursor > text.length) return null
  const prefix = text.slice(0, cursor)
  const match = /(?:^|\s)\$([^\s$]*)$/.exec(prefix)
  if (!match) return null
  const start = cursor - match[1]!.length - 1
  return { start, end: cursor, query: match[1]! }
}

export function removeSkillTrigger(
  text: string,
  trigger: SkillTrigger,
): { text: string; cursor: number } {
  const before = text.slice(0, trigger.start)
  let after = text.slice(trigger.end)
  if (/^[\t ]/.test(after) && (!before || /[\t ]$/.test(before))) after = after.slice(1)
  const needsSpace = Boolean(before && after && !/\s$/.test(before) && !/^\s/.test(after))
  const replacement = needsSpace ? ' ' : ''
  return {
    text: `${before}${replacement}${after}`,
    cursor: before.length + replacement.length,
  }
}

export function filterSkills(
  skills: readonly SkillSummary[],
  query: string,
): SkillSummary[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return [...skills]
  return skills
    .map((skill, index) => ({
      skill,
      index,
      rank: skill.name.toLocaleLowerCase().startsWith(normalized)
        ? 0
        : skill.name.toLocaleLowerCase().includes(normalized)
          ? 1
          : skill.description.toLocaleLowerCase().includes(normalized)
            ? 2
            : 3,
    }))
    .filter((item) => item.rank < 3)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((item) => item.skill)
}
