import { resolve } from 'node:path'
import {
  SKILL_MAX_SELECTIONS_PER_MESSAGE,
  skillLocatorSchema,
  type ActivatedSkill,
  type PendingUserInput,
  type SkillLocator,
} from '@whycode/core'

interface SkillActivator {
  activateMany(
    locators: readonly SkillLocator[],
    projectDir: string | null,
    contextWindow?: number,
  ): Promise<ActivatedSkill[]>
}

export interface PrepareMessageSkillsOptions {
  catalog: SkillActivator
  locators: readonly SkillLocator[] | undefined
  projectDir: string | null
  contextWindow?: number
  restoredInputIds?: readonly string[]
  pendingInputs?: readonly PendingUserInput[]
}

/** 恢复草稿复用 JSONL 冻结正文；本条消息新选的 locator 才读取当前磁盘。 */
export async function prepareMessageSkills(
  options: PrepareMessageSkillsOptions,
): Promise<ActivatedSkill[]> {
  if (options.locators === undefined) return []
  const locators = skillLocatorSchema.array()
    .max(SKILL_MAX_SELECTIONS_PER_MESSAGE)
    .parse(options.locators)
  const seenIds = new Set<string>()
  for (const locator of locators) {
    if (seenIds.has(locator.id)) throw new Error('同一条消息不能重复选择同一个 Skill')
    seenIds.add(locator.id)
  }

  const restored = restoredSkills(options.restoredInputIds ?? [], options.pendingInputs ?? [])
  const unresolved = locators.filter((locator) => !restored.has(locatorKey(locator)))
  const activated = unresolved.length > 0
    ? await options.catalog.activateMany(unresolved, options.projectDir, options.contextWindow)
    : []
  const current = new Map(unresolved.map((locator, index) => [
    locatorKey(locator),
    activated[index]!,
  ]))
  return locators.map((locator) => {
    const skill = restored.get(locatorKey(locator)) ?? current.get(locatorKey(locator))
    if (!skill) throw new Error('Skill 消息准备结果不完整')
    return structuredClone(skill)
  })
}

function restoredSkills(
  restoredInputIds: readonly string[],
  pendingInputs: readonly PendingUserInput[],
): Map<string, ActivatedSkill> {
  const restoredIds = new Set(restoredInputIds)
  const result = new Map<string, ActivatedSkill>()
  for (const input of pendingInputs) {
    if (!restoredIds.has(input.id) || input.state !== 'restored') continue
    for (const skill of input.skills ?? []) {
      const key = locatorKey(skill)
      const previous = result.get(key)
      if (previous && JSON.stringify(previous) !== JSON.stringify(skill)) {
        throw new Error('多条恢复消息包含相互冲突的 Skill 快照，请按原顺序逐条提交')
      }
      result.set(key, structuredClone(skill))
    }
  }
  return result
}

function locatorKey(locator: SkillLocator): string {
  const path = resolve(locator.path).replaceAll('\\', '/')
  return `${locator.id}\0${process.platform === 'win32' ? path.toLowerCase() : path}`
}
