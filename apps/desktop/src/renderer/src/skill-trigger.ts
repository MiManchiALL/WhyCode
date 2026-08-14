import type { SkillSummary } from '@whycode/core/skills'

export interface SlashTrigger {
  start: number
  end: number
  query: string
}

export type ComposerCommandId = 'compact' | 'fork'

export interface ComposerCommand {
  id: ComposerCommandId
  name: string
  description: string
  keywords: readonly string[]
  disabled: boolean
}

export type ComposerMenuItem =
  | { kind: 'command'; command: ComposerCommand }
  | { kind: 'skill'; skill: SkillSummary }

/**
 * Slash 功能只在当前行的输入起点触发。这样既符合命令面板习惯，也不会把正文中的
 * Unix 路径、URL 或除法表达式误识别为命令。
 */
export function findSlashTrigger(text: string, cursor: number | null): SlashTrigger | null {
  if (cursor === null || cursor < 0 || cursor > text.length) return null
  const prefix = text.slice(0, cursor)
  const lineStart = prefix.lastIndexOf('\n') + 1
  const currentLine = prefix.slice(lineStart)
  const match = /^(\s*)\/([^\s/]*)$/.exec(currentLine)
  if (!match) return null
  const start = lineStart + match[1]!.length
  return { start, end: cursor, query: match[2]! }
}

export function removeSlashTrigger(
  text: string,
  trigger: SlashTrigger,
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

export function filterComposerItems(
  commands: readonly ComposerCommand[],
  skills: readonly SkillSummary[],
  selectedIds: ReadonlySet<string>,
  query: string,
): ComposerMenuItem[] {
  const normalized = query.trim().toLocaleLowerCase()
  const rankedCommands = commands
    .map((command, index) => ({
      item: { kind: 'command', command } as const,
      index,
      rank: commandRank(command, normalized),
    }))
    .filter((entry) => entry.rank < 3)

  const rankedSkills = skills
    .filter((skill) => !selectedIds.has(skill.id))
    .map((skill, index) => ({
      item: { kind: 'skill', skill } as const,
      index,
      rank: skillRank(skill, normalized),
    }))
    .filter((entry) => entry.rank < 3)

  return [
    ...rankedCommands
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map((entry) => entry.item),
    ...rankedSkills
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map((entry) => entry.item),
  ]
}

function commandRank(command: ComposerCommand, query: string): number {
  if (!query) return 0
  const names = [command.name, ...command.keywords]
    .map((value) => value.toLocaleLowerCase())
  if (names.some((value) => value.startsWith(query))) return 0
  if (names.some((value) => value.includes(query))) return 1
  if (command.description.toLocaleLowerCase().includes(query)) return 2
  return 3
}

function skillRank(skill: SkillSummary, query: string): number {
  if (!query) return 0
  const name = skill.name.toLocaleLowerCase()
  if (name.startsWith(query)) return 0
  if (name.includes(query)) return 1
  if (skill.description.toLocaleLowerCase().includes(query)) return 2
  return 3
}
