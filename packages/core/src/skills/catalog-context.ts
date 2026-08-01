import { estimateTextTokens } from '../context/tokens.ts'
import type { SkillSummary } from './types.ts'
import { escapeSkillXmlText } from './xml.ts'

const DEFAULT_METADATA_CHAR_BUDGET = 8_000
const METADATA_CONTEXT_PERCENT = 2

export function renderSkillCatalog(
  skills: readonly SkillSummary[],
  contextWindow?: number,
): { text: string | null; omittedCount: number } {
  if (skills.length === 0) return { text: null, omittedCount: 0 }
  const budget = contextWindow && contextWindow > 0
    ? {
        kind: 'tokens' as const,
        limit: Math.max(1, Math.floor(contextWindow * METADATA_CONTEXT_PERCENT / 100)),
      }
    : { kind: 'characters' as const, limit: DEFAULT_METADATA_CHAR_BUDGET }
  const header = [
    '<available_skills>',
    '以下 Skill 可用于当前根任务。仅在与请求匹配时调用 Skill，并使用精确 id；不要只按同名猜测。',
    'Skill 不会自动延续到下一根任务；下一根任务需要重新选择或重新调用。',
  ]
  const footer = '</available_skills>'
  const render = (lines: readonly string[]) => [...header, ...lines, footer].join('\n')
  if (cost(budget, render([])) > budget.limit) {
    return { text: null, omittedCount: skills.length }
  }

  const minimumLines = skills.map(minimumSkillLine)
  const fullText = render(skills.map((skill) =>
    `${minimumSkillLine(skill)} — ${catalogDescription(skill.description)}`))
  if (cost(budget, fullText) <= budget.limit) {
    return { text: fullText, omittedCount: 0 }
  }

  const minimumText = render(minimumLines)
  if (cost(budget, minimumText) <= budget.limit) {
    const available = Math.max(0, budget.limit - cost(budget, minimumText))
    const share = Math.floor(available / skills.length)
    const lines = skills.map((skill, index) => {
      const description = truncateDescription(skill.description, minimumLines[index]!, share, budget)
      return description ? `${minimumLines[index]} — ${description}` : minimumLines[index]!
    })
    // token 估算并非严格线性；从尾部收敛，保证最终目录不越过预算。
    while (cost(budget, render(lines)) > budget.limit) {
      const index = lines.findLastIndex((line, itemIndex) => line !== minimumLines[itemIndex])
      if (index < 0) break
      lines[index] = minimumLines[index]!
    }
    return { text: render(lines), omittedCount: 0 }
  }

  const lines: string[] = []
  for (const line of minimumLines) {
    if (cost(budget, render([...lines, line])) > budget.limit) break
    lines.push(line)
  }
  const omittedCount = skills.length - lines.length
  if (omittedCount > 0) {
    const marker = `- 另有 ${omittedCount} 个 Skill 因目录预算省略`
    if (cost(budget, render([...lines, marker])) <= budget.limit) lines.push(marker)
  }
  return lines.length > 0
    ? { text: render(lines), omittedCount }
    : { text: null, omittedCount }
}

function minimumSkillLine(skill: SkillSummary): string {
  return [
    `- ${escapeSkillXmlText(skill.name)}`,
    `id=${escapeSkillXmlText(skill.id)}`,
    `scope=${escapeSkillXmlText(skill.scope)}`,
    `path=${escapeSkillXmlText(skill.path)}`,
  ].join(' | ')
}

function cost(
  budget: { kind: 'tokens' | 'characters'; limit: number },
  text: string,
): number {
  return budget.kind === 'tokens' ? estimateTextTokens(`${text}\n`) : [...`${text}\n`].length
}

function truncateDescription(
  text: string,
  prefix: string,
  limit: number,
  budget: { kind: 'tokens' | 'characters'; limit: number },
): string {
  if (limit <= 0) return ''
  const normalized = normalizeDescription(text)
  const incrementalCost = (value: string) =>
    cost(budget, `${prefix} — ${escapeSkillXmlText(value)}`) - cost(budget, prefix)
  if (incrementalCost(normalized) <= limit) return escapeSkillXmlText(normalized)
  const characters = [...normalized]
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = `${characters.slice(0, middle).join('')}…`
    if (incrementalCost(candidate) <= limit) low = middle
    else high = middle - 1
  }
  return low > 0
    ? escapeSkillXmlText(`${characters.slice(0, low).join('')}…`)
    : ''
}

function catalogDescription(value: string): string {
  return escapeSkillXmlText(normalizeDescription(value))
}

function normalizeDescription(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}
