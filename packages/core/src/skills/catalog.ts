import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { renderSkillCatalog } from './catalog-context.ts'
import { discoverSkillFiles, discoveryRoots, skillPathKey } from './discovery.ts'
import { parseSkillDocument } from './parser.ts'
import { readBoundedSkillFile } from './read.ts'
import {
  SKILL_FILE_NAME,
  SKILL_MAX_DOCUMENT_BYTES,
  SKILL_MAX_SELECTIONS_PER_MESSAGE,
  skillLocatorSchema,
  type ActivatedSkill,
  type SkillCatalogSnapshot,
  type SkillDiagnostic,
  type SkillLocator,
  type SkillScope,
  type SkillTurnSnapshot,
  skillSummary,
} from './types.ts'

const MAX_PARSED_FILE_CACHE = 20_000
const DEFAULT_MAX_PARSED_CACHE_BYTES = 32 * 1_024 * 1_024
const DEFAULT_MAX_SNAPSHOT_BYTES = 32 * 1_024 * 1_024

interface CachedSkill {
  signature: string
  value: ActivatedSkill | null
  diagnostic?: string
  costBytes: number
}

export interface SkillCatalogOptions {
  homeDir?: string
  /** 测试/宿主可收紧；默认 32 MiB，避免大量合法大文件占满进程内存。 */
  maxParsedCacheBytes?: number
  /** 单个任务冻结的正文总量；达到后按发现优先级稳定截断。 */
  maxSnapshotBytes?: number
}

/**
 * Skill 磁盘事实源。每次根任务重新枚举目录，因此新增/删除下一轮必然可见；
 * 未变化文件按身份与时间/尺寸签名复用有界解析结果，当前 turn 持有独立冻结快照。
 */
export class SkillCatalogService {
  private readonly homeDir: string | undefined
  private readonly parsedFiles = new Map<string, CachedSkill>()
  private readonly maxParsedCacheBytes: number
  private readonly maxSnapshotBytes: number
  private parsedCacheBytes = 0

  constructor(options: SkillCatalogOptions = {}) {
    this.homeDir = options.homeDir ? resolve(options.homeDir) : undefined
    this.maxParsedCacheBytes = positiveBudget(
      options.maxParsedCacheBytes,
      DEFAULT_MAX_PARSED_CACHE_BYTES,
    )
    this.maxSnapshotBytes = positiveBudget(
      options.maxSnapshotBytes,
      DEFAULT_MAX_SNAPSHOT_BYTES,
    )
  }

  async snapshot(
    projectDir: string | null,
    contextWindow?: number,
  ): Promise<SkillTurnSnapshot> {
    const diagnostics: SkillDiagnostic[] = []
    const roots = await discoveryRoots(projectDir, this.homeDir)
    const entries: ActivatedSkill[] = []
    const seenPaths = new Set<string>()
    let snapshotBytes = 0

    rootLoop: for (const root of roots) {
      const discovered = await discoverSkillFiles(root.path, diagnostics)
      for (const path of discovered) {
        const key = skillPathKey(path)
        if (seenPaths.has(key)) continue
        seenPaths.add(key)
        const parsed = await this.loadSkill(path, root.scope, diagnostics)
        if (!parsed) continue
        const contentBytes = Buffer.byteLength(parsed.content, 'utf8')
        if (snapshotBytes + contentBytes > this.maxSnapshotBytes) {
          diagnostics.push({
            path,
            message: `任务 Skill 正文达到 ${this.maxSnapshotBytes} 字节总预算，后续项已省略`,
          })
          break rootLoop
        }
        snapshotBytes += contentBytes
        entries.push(parsed)
      }
    }

    // loadSkill 已从缓存复制；本地数组本身就是当前任务唯一冻结快照。
    const frozen = entries
    const summaries = frozen.map(skillSummary)
    const rendered = renderSkillCatalog(summaries, contextWindow)
    return {
      revision: catalogRevision(frozen),
      skills: summaries,
      entries: frozen,
      diagnostics,
      modelContext: rendered.text,
      omittedCount: rendered.omittedCount,
    }
  }

  async list(
    projectDir: string | null,
    contextWindow?: number,
  ): Promise<SkillCatalogSnapshot> {
    const { entries: _entries, ...catalog } = await this.snapshot(projectDir, contextWindow)
    return catalog
  }

  async activate(
    locator: SkillLocator,
    projectDir: string | null,
    contextWindow?: number,
  ): Promise<ActivatedSkill> {
    return (await this.activateMany([locator], projectDir, contextWindow))[0]!
  }

  async activateMany(
    locators: readonly SkillLocator[],
    projectDir: string | null,
    contextWindow?: number,
  ): Promise<ActivatedSkill[]> {
    const parsedLocators = skillLocatorSchema.array()
      .max(SKILL_MAX_SELECTIONS_PER_MESSAGE)
      .parse(locators)
    const snapshot = await this.snapshot(projectDir, contextWindow)
    const selected = new Set<string>()
    return parsedLocators.map((locator) => {
      const requestedPath = skillPathKey(locator.path)
      const skill = snapshot.entries.find((entry) =>
        entry.id === locator.id && skillPathKey(entry.path) === requestedPath)
      if (!skill) throw new Error('所选 Skill 已移动、删除或不属于当前工作区')
      if (selected.has(skill.id)) throw new Error(`不能重复选择 Skill：${skill.name}`)
      selected.add(skill.id)
      return structuredClone(skill)
    })
  }

  invalidate(): void {
    this.parsedFiles.clear()
    this.parsedCacheBytes = 0
  }

  private async loadSkill(
    path: string,
    scope: SkillScope,
    diagnostics: SkillDiagnostic[],
  ): Promise<ActivatedSkill | null> {
    let signature: string
    let size: bigint
    try {
      const metadata = await lstat(path, { bigint: true })
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('SKILL.md 必须是普通文件且不能是符号链接')
      }
      size = metadata.size
      signature = [
        metadata.dev,
        metadata.ino,
        metadata.size,
        metadata.mtimeNs,
        metadata.ctimeNs,
      ].join(':')
    } catch (error) {
      diagnostics.push({
        path,
        message: error instanceof Error ? error.message : String(error),
      })
      return null
    }
    const key = skillPathKey(path)
    const cached = this.parsedFiles.get(key)
    if (cached?.signature === signature) {
      this.parsedFiles.delete(key)
      this.parsedFiles.set(key, cached)
      if (cached.diagnostic) diagnostics.push({ path, message: cached.diagnostic })
      return cached.value ? structuredClone(cached.value) : null
    }
    try {
      if (size > BigInt(SKILL_MAX_DOCUMENT_BYTES)) {
        throw new Error(`SKILL.md 超过 ${SKILL_MAX_DOCUMENT_BYTES} 字节上限`)
      }
      const bytes = await readBoundedSkillFile(path, SKILL_MAX_DOCUMENT_BYTES)
      let content: string
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        throw new Error('SKILL.md 必须是有效 UTF-8 文本')
      }
      const value = parseSkillDocument({ path, scope, content })
      this.cacheFile(key, {
        signature,
        value,
        costBytes: cachedSkillCost(value),
      })
      return structuredClone(value)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.cacheFile(key, {
        signature,
        value: null,
        diagnostic: message,
        costBytes: Buffer.byteLength(`${path}\n${message}`, 'utf8') + 128,
      })
      diagnostics.push({
        path,
        message,
      })
      return null
    }
  }

  private cacheFile(key: string, cached: CachedSkill): void {
    const previous = this.parsedFiles.get(key)
    if (previous) {
      this.parsedCacheBytes -= previous.costBytes
      this.parsedFiles.delete(key)
    }
    if (cached.costBytes > this.maxParsedCacheBytes) return
    while (
      this.parsedFiles.size >= MAX_PARSED_FILE_CACHE
      || this.parsedCacheBytes + cached.costBytes > this.maxParsedCacheBytes
    ) {
      if (!this.evictOldest()) break
    }
    this.parsedFiles.set(key, cached)
    this.parsedCacheBytes += cached.costBytes
  }

  private evictOldest(): boolean {
    const oldest = this.parsedFiles.keys().next().value
    if (typeof oldest !== 'string') return false
    const cached = this.parsedFiles.get(oldest)
    this.parsedFiles.delete(oldest)
    if (cached) this.parsedCacheBytes -= cached.costBytes
    return true
  }
}

function catalogRevision(skills: readonly ActivatedSkill[]): string {
  const value = skills
    .map((skill) => `${skill.id}:${skill.scope}:${skill.digest}`)
    .join('\n')
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function cachedSkillCost(skill: ActivatedSkill): number {
  return Buffer.byteLength([
    skill.path,
    skill.rootPath,
    skill.name,
    skill.description,
    skill.content,
  ].join('\n'), 'utf8') + 256
}

function positiveBudget(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback
}
