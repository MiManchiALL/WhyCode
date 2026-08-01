import { z } from 'zod'
import { isWellFormedUnicode } from '../text.ts'

export const SKILL_FILE_NAME = 'SKILL.md'
export const SKILL_MAX_NAME_CHARS = 64
export const SKILL_MAX_DESCRIPTION_CHARS = 1_024
export const SKILL_MAX_DOCUMENT_BYTES = 256 * 1_024
export const SKILL_MAX_RESOURCE_BYTES = 512 * 1_024
export const SKILL_MAX_SELECTIONS_PER_MESSAGE = 8
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const utf8Encoder = new TextEncoder()
const skillPathSchema = z.string()
  .min(1)
  .refine(isWellFormedUnicode, { message: 'Skill path 包含孤立 Unicode 代理项' })
const skillDescriptionSchema = z.string()
  .min(1)
  .max(SKILL_MAX_DESCRIPTION_CHARS)
  .refine(isWellFormedUnicode, { message: 'Skill description 包含孤立 Unicode 代理项' })
const skillContentSchema = z.string()
  .min(1)
  .max(SKILL_MAX_DOCUMENT_BYTES)
  .refine(isWellFormedUnicode, { message: 'Skill content 包含孤立 Unicode 代理项' })
  .refine(
    (content) => utf8Encoder.encode(content).byteLength <= SKILL_MAX_DOCUMENT_BYTES,
    { message: `Skill content 超过 ${SKILL_MAX_DOCUMENT_BYTES} 字节上限` },
  )

export const skillScopeSchema = z.enum(['project', 'user', 'system'])

export const skillLocatorSchema = z.object({
  id: z.string().regex(/^skill:[a-f0-9]{64}$/),
  path: skillPathSchema,
}).strict()

export const skillSummarySchema = skillLocatorSchema.extend({
  name: z.string()
    .min(1)
    .max(SKILL_MAX_NAME_CHARS)
    .regex(SKILL_NAME_PATTERN),
  description: skillDescriptionSchema,
  scope: skillScopeSchema,
  rootPath: skillPathSchema,
}).strict()

export const activatedSkillSchema = skillSummarySchema.extend({
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  // 浏览器安全的 TextEncoder 让磁盘解析与 JSONL/IPC 恢复共用同一 UTF-8 字节边界。
  content: skillContentSchema,
}).strict()

export type SkillScope = z.infer<typeof skillScopeSchema>
export type SkillLocator = z.infer<typeof skillLocatorSchema>
export type SkillSummary = z.infer<typeof skillSummarySchema>
export type ActivatedSkill = z.infer<typeof activatedSkillSchema>

export interface SkillDiagnostic {
  path: string
  message: string
}

export interface SkillCatalogSnapshot {
  revision: string
  skills: SkillSummary[]
  diagnostics: SkillDiagnostic[]
  modelContext: string | null
  omittedCount: number
}

/** 当前根任务持有的不可变磁盘快照；不跨根任务复用。 */
export interface SkillTurnSnapshot extends SkillCatalogSnapshot {
  entries: ActivatedSkill[]
}

export function skillSummary(skill: ActivatedSkill): SkillSummary {
  const { content: _content, digest: _digest, ...summary } = skill
  return summary
}
