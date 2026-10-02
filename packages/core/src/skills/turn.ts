import type { ModelMessage } from 'ai'
import { estimateMessagesTokens } from '../context/tokens.ts'
import type { SkillCatalogService } from './catalog.ts'
import { applySkillContext } from './context.ts'
import {
  activatedSkillSchema,
  SKILL_FILE_NAME,
  skillSummary,
  type SkillSummary,
  type ActivatedSkill,
  type SkillTurnSnapshot,
  type PrepareSkillRuntime,
  type SkillRuntimeContext,
} from './types.ts'

interface ActiveSkill { snapshot: ActivatedSkill; runtime?: string }

export interface StartSkillTurnOptions {
  skills: readonly ActivatedSkill[]
  projectDir: string | null
  contextWindow?: number
  enabled: boolean
  onCatalogError: (error: unknown) => void
}

/** 单一根任务内的目录快照、显式/隐式激活与历史投影边界。 */
export class SkillTurnContext {
  private readonly service?: SkillCatalogService
  private readonly onActiveSkillsChanged?: (skills: SkillSummary[]) => void
  private catalog: SkillTurnSnapshot | null = null
  private readonly active = new Map<string, ActiveSkill>()
  private readonly visibleResultCallIds = new Set<string>()

  constructor(
    service?: SkillCatalogService,
    onActiveSkillsChanged?: (skills: SkillSummary[]) => void,
  ) {
    this.service = service
    this.onActiveSkillsChanged = onActiveSkillsChanged
  }

  get catalogSnapshot(): SkillTurnSnapshot | null {
    return this.catalog
  }

  get activeSkills(): SkillSummary[] {
    return [...this.active.values()].map(entry => skillSummary(entry.snapshot))
  }

  async start(options: StartSkillTurnOptions): Promise<void> {
    this.clear()
    this.add(options.skills)
    if (!this.service || !options.enabled) return
    try {
      this.catalog = await this.service.snapshot(options.projectDir, options.contextWindow)
    } catch (error) {
      options.onCatalogError(error)
    }
  }

  add(skills: readonly ActivatedSkill[]): void {
    for (const candidate of skills) {
      const skill = activatedSkillSchema.parse(candidate)
      this.active.set(skill.id, { snapshot: skill })
    }
    if (skills.length > 0) this.onActiveSkillsChanged?.(this.activeSkills)
  }

  async prepare(prepareRuntime: PrepareSkillRuntime | undefined, context: SkillRuntimeContext): Promise<void> {
    for (const entry of this.active.values()) await this.prepareEntry(entry, prepareRuntime, context)
  }

  async activate(skill: ActivatedSkill, prepareRuntime: PrepareSkillRuntime | undefined, context: SkillRuntimeContext): Promise<string> {
    // 显式选择的冻结正文优先；失败的隐式加载不进入活动上下文。
    const entry = this.active.get(skill.id) ?? { snapshot: skill }
    await this.prepareEntry(entry, prepareRuntime, context)
    if (!this.active.has(skill.id)) {
      this.active.set(skill.id, entry)
      this.onActiveSkillsChanged?.(this.activeSkills)
    }
    return projectedSkill(entry).content
  }

  private async prepareEntry(entry: ActiveSkill, prepareRuntime: PrepareSkillRuntime | undefined, context: SkillRuntimeContext): Promise<void> {
    if (!prepareRuntime || entry.runtime !== undefined) return
    context.abortSignal.throwIfAborted()
    const runtime = await prepareRuntime(skillSummary(entry.snapshot), context)
    context.abortSignal.throwIfAborted()
    entry.runtime = runtime ?? ''
  }

  recordToolResult(toolCallId: string, input: unknown, succeeded: boolean): void {
    if (!succeeded) {
      this.visibleResultCallIds.add(toolCallId)
      return
    }
    const payload = input && typeof input === 'object' ? input : null
    const resourcePath = payload && 'resourcePath' in payload ? payload.resourcePath : undefined
    if (typeof resourcePath === 'string' && resourcePath !== SKILL_FILE_NAME) {
      // 包内参考资料没有等价的活动上下文，当前根任务必须保留这次工具结果。
      this.visibleResultCallIds.add(toolCallId)
    }
  }

  project(messages: readonly ModelMessage[], includeActiveContext = true): ModelMessage[] {
    return applySkillContext(
      messages,
      includeActiveContext ? this.catalog : null,
      includeActiveContext ? [...this.active.values()].map(projectedSkill) : [],
      includeActiveContext ? this.visibleResultCallIds : new Set(),
    )
  }

  /**
   * Skill 请求投影相对长期消息的 token 差值。API usage 已经包含上一次投影，
   * AgentSession 用本次差值减去基线差值，避免活动正文变化时漏算或重复计算。
   */
  estimatedProjectionTokenDelta(messages: readonly ModelMessage[]): number {
    const projected = this.project(messages)
    return estimateMessagesTokens(projected) - estimateMessagesTokens(messages)
  }

  /** 历史即使全部压缩，仍无法消除的当前 Skill 目录与活动正文开销。 */
  injectedContextTokenEstimate(): number {
    return estimateMessagesTokens(this.project([]))
  }

  /** 根任务结束：保留下一次普通请求仍会使用的目录，只清除 turn 级正文与结果可见性。 */
  finish(): void {
    const hadActiveSkills = this.active.size > 0
    this.active.clear()
    this.visibleResultCallIds.clear()
    if (hadActiveSkills) this.onActiveSkillsChanged?.([])
  }

  /** 开始新快照或物理关闭 Skill 能力时清除全部请求投影。 */
  clear(): void {
    this.catalog = null
    this.finish()
  }
}

function projectedSkill(entry: ActiveSkill): ActivatedSkill {
  return entry.runtime ? { ...entry.snapshot, content: `${entry.snapshot.content}\n\n${entry.runtime}` } : entry.snapshot
}
