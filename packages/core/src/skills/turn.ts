import type { ModelMessage } from 'ai'
import { estimateMessageTokens } from '../context/tokens.ts'
import type { SkillCatalogService } from './catalog.ts'
import { applySkillContext } from './context.ts'
import {
  activatedSkillSchema,
  SKILL_FILE_NAME,
  type ActivatedSkill,
  type SkillTurnSnapshot,
} from './types.ts'

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
  private catalog: SkillTurnSnapshot | null = null
  private readonly active = new Map<string, ActivatedSkill>()
  private readonly visibleResultCallIds = new Set<string>()

  constructor(service?: SkillCatalogService) {
    this.service = service
  }

  get catalogSnapshot(): SkillTurnSnapshot | null {
    return this.catalog
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
      this.active.set(skill.id, structuredClone(skill))
    }
  }

  recordToolResult(toolCallId: string, input: unknown, succeeded: boolean): void {
    if (!succeeded) {
      this.visibleResultCallIds.add(toolCallId)
      return
    }
    const payload = input && typeof input === 'object' ? input : null
    const skillId = payload && 'skillId' in payload
      ? payload.skillId
      : null
    if (typeof skillId !== 'string') return
    const skill = this.catalog?.entries.find((entry) => entry.id === skillId)
    // 已由用户显式选择或 steering 更新的冻结快照优先；模型重复调用不能用稍后磁盘版本改写它。
    if (skill && !this.active.has(skill.id)) this.add([skill])
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
      includeActiveContext ? [...this.active.values()] : [],
      includeActiveContext ? this.visibleResultCallIds : new Set(),
    )
  }

  /**
   * Skill 请求投影相对长期消息的 token 差值。API usage 已经包含上一次投影，
   * AgentSession 用本次差值减去基线差值，避免活动正文变化时漏算或重复计算。
   */
  estimatedProjectionTokenDelta(messages: readonly ModelMessage[]): number {
    const projected = this.project(messages)
    return tokenEstimate(projected) - tokenEstimate(messages)
  }

  /** 历史即使全部压缩，仍无法消除的当前 Skill 目录与活动正文开销。 */
  injectedContextTokenEstimate(): number {
    return tokenEstimate(this.project([]))
  }

  clear(): void {
    this.catalog = null
    this.active.clear()
    this.visibleResultCallIds.clear()
  }
}

function tokenEstimate(messages: readonly ModelMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0)
}
