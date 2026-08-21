import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { Dirent } from 'node:fs'
import { parseDocument } from 'yaml'
import {
  type SubagentDefinitionCatalogSnapshot,
  type SubagentDefinitionDiagnostic,
  type SubagentDefinitionScope,
  type SubagentDefinitionSnapshot,
  type SubagentProfile,
  subagentDefinitionSnapshotSchema,
  subagentProfileSchema,
} from './types.ts'

const MAX_AGENT_FILES_PER_ROOT = 128
const MAX_AGENT_FILE_BYTES = 64 * 1_024
const MAX_AGENT_BYTES_PER_ROOT = 2 * 1_024 * 1_024
const AGENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const FRONTMATTER_RE = /^---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/
const AGENT_METADATA_KEYS = new Set(['name', 'description', 'profile', 'tools'])

export const SUBAGENT_ALLOWED_TOOL_NAMES = [
  'ReadFile',
  'ListDir',
  'Glob',
  'Grep',
  'WriteFile',
  'EditFile',
  'DeleteFile',
  'MoveFile',
  'RunCommand',
  'WebSearch',
  'WebFetch',
  'WebFind',
  'ViewImage',
  'Skill',
] as const

const ALLOWED_TOOL_NAMES = new Set<string>(SUBAGENT_ALLOWED_TOOL_NAMES)

const PROFILE_TOOLS: Record<SubagentProfile, readonly string[]> = {
  explore: [
    'ReadFile', 'ListDir', 'Glob', 'Grep',
    'WebSearch', 'WebFetch', 'WebFind', 'ViewImage', 'Skill',
  ],
  reviewer: [
    'ReadFile', 'ListDir', 'Glob', 'Grep', 'RunCommand',
    'WebSearch', 'WebFetch', 'WebFind', 'ViewImage', 'Skill',
  ],
  general: [...SUBAGENT_ALLOWED_TOOL_NAMES],
}

const BUILTIN_DEFINITIONS: readonly SubagentDefinitionSnapshot[] = [
  builtin(
    'explore',
    '探索代理',
    '只读检索代码、文件和公开资料，形成基于证据的调查结果。',
    '专注于读取、搜索和核实。不要修改文件，也不要用命令绕过只读工具边界。',
  ),
  builtin(
    'reviewer',
    '审查代理',
    '只读审查实现、运行验证命令并报告具体证据、风险和建议。',
    '以代码和验证结果为事实来源。可以运行命令，但不要修改、删除或移动文件。',
  ),
  builtin(
    'general',
    '通用代理',
    '独立完成边界明确的实现、调研或验证任务。',
    '持续推进委派目标，在权限范围内读取、修改和验证；最终给出完整、自包含的结果。',
  ),
]

export interface SubagentDefinitionCatalogOptions {
  homeDir?: string
}

/** 每次父任务开始时重新读取小型定义目录；定义在创建子代理时再冻结进 manifest。 */
export class SubagentDefinitionCatalogService {
  private readonly homeDir: string | undefined

  constructor(options: SubagentDefinitionCatalogOptions = {}) {
    this.homeDir = options.homeDir ? resolve(options.homeDir) : undefined
  }

  async snapshot(projectDir: string | null): Promise<SubagentDefinitionCatalogSnapshot> {
    const diagnostics: SubagentDefinitionDiagnostic[] = []
    const definitions = new Map<string, SubagentDefinitionSnapshot>(
      BUILTIN_DEFINITIONS.map((definition) => [definition.id, structuredClone(definition)]),
    )
    const roots: Array<{ path: string; scope: Exclude<SubagentDefinitionScope, 'builtin'> }> = []
    if (this.homeDir) roots.push({ path: join(this.homeDir, '.whycode', 'agents'), scope: 'user' })
    if (projectDir) roots.push({ path: join(resolve(projectDir), '.whycode', 'agents'), scope: 'project' })

    for (const root of roots) {
      const entries = await readAgentDirectory(root.path, diagnostics)
      let loadedBytes = 0
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MAX_AGENT_FILES_PER_ROOT)
      for (const file of files) {
        const path = join(root.path, file.name)
        try {
          const definition = await loadCustomDefinition(path, root.scope)
          const cost = Buffer.byteLength(definition.instructions, 'utf8')
          if (loadedBytes + cost > MAX_AGENT_BYTES_PER_ROOT) {
            diagnostics.push({
              path: root.path,
              message: `Agent 定义正文达到 ${MAX_AGENT_BYTES_PER_ROOT} 字节总预算，后续项已省略`,
            })
            break
          }
          loadedBytes += cost
          definitions.set(definition.id, definition)
        } catch (error) {
          diagnostics.push({
            path,
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).length > files.length) {
        diagnostics.push({
          path: root.path,
          message: `只加载前 ${MAX_AGENT_FILES_PER_ROOT} 个 Agent 定义`,
        })
      }
    }

    const values = [...definitions.values()]
    return {
      definitions: values,
      diagnostics,
      modelContext: renderCatalog(values),
    }
  }
}

function builtin(
  id: SubagentProfile,
  name: string,
  description: string,
  instructions: string,
): SubagentDefinitionSnapshot {
  return subagentDefinitionSnapshotSchema.parse({
    id,
    name,
    description,
    profile: id,
    scope: 'builtin',
    instructions,
    toolNames: PROFILE_TOOLS[id],
  })
}

async function loadCustomDefinition(
  path: string,
  scope: Exclude<SubagentDefinitionScope, 'builtin'>,
): Promise<SubagentDefinitionSnapshot> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Agent 定义必须是普通文件且不能是符号链接')
  }
  if (info.size > MAX_AGENT_FILE_BYTES) {
    throw new Error(`Agent 定义超过 ${MAX_AGENT_FILE_BYTES} 字节上限`)
  }
  const bytes = await readFile(path)
  if (bytes.byteLength > MAX_AGENT_FILE_BYTES) {
    throw new Error(`Agent 定义超过 ${MAX_AGENT_FILE_BYTES} 字节上限`)
  }
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Agent 定义必须是有效 UTF-8 文本')
  }
  const frontmatter = FRONTMATTER_RE.exec(content.replace(/^\uFEFF/, ''))
  if (!frontmatter) throw new Error('缺少以 --- 包围的 YAML frontmatter')
  const document = parseDocument(frontmatter[1]!, { prettyErrors: false, uniqueKeys: true })
  if (document.errors.length > 0) throw new Error(`YAML 无效：${document.errors[0]!.message}`)
  const metadata = document.toJS({ maxAliasCount: 0 }) as unknown
  if (!isPlainObject(metadata)) throw new Error('YAML frontmatter 必须是对象')
  const unknownKey = Object.keys(metadata).find((key) => !AGENT_METADATA_KEYS.has(key))
  if (unknownKey) throw new Error(`YAML frontmatter 包含未知字段：${unknownKey}`)

  const name = requiredString(metadata, 'name')
  if (!AGENT_NAME_PATTERN.test(name) || name.length > 64) {
    throw new Error('name 必须为不超过 64 个字符的小写字母、数字和单连字符组合')
  }
  if (basename(path, '.md') !== name) throw new Error('name 必须与 Markdown 文件名一致')
  const description = requiredString(metadata, 'description')
  const profile = subagentProfileSchema.parse(metadata.profile ?? 'general')
  const declaredTools = optionalStringArray(metadata, 'tools')
  for (const tool of declaredTools) {
    if (!ALLOWED_TOOL_NAMES.has(tool)) throw new Error(`子代理不允许使用工具：${tool}`)
  }
  const instructions = content.slice(frontmatter[0].length).trim()
  return subagentDefinitionSnapshotSchema.parse({
    id: `custom:${scope}:${name}`,
    name,
    description,
    profile,
    scope,
    instructions,
    toolNames: [...new Set([...PROFILE_TOOLS[profile], ...declaredTools])],
    sourcePath: resolve(path),
  })
}

function renderCatalog(definitions: readonly SubagentDefinitionSnapshot[]): string {
  const items = definitions.map((definition) => JSON.stringify({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    profile: definition.profile,
  }))
  return [
    '<available_subagents>',
    ...items,
    '</available_subagents>',
  ].join('\n')
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || !field.trim()) throw new Error(`${key} 必须是非空字符串`)
  return field.trim()
}

function optionalStringArray(value: Record<string, unknown>, key: string): string[] {
  const field = value[key]
  if (field === undefined) return []
  if (!Array.isArray(field) || field.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${key} 必须是字符串数组`)
  }
  return field.map((item) => item.trim())
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

async function readAgentDirectory(
  path: string,
  diagnostics: SubagentDefinitionDiagnostic[],
): Promise<Dirent<string>[]> {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      diagnostics.push({ path, message: 'Agent 根路径必须是普通目录且不能是符号链接' })
      return []
    }
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return []
    diagnostics.push({
      path,
      message: `Agent 根目录读取失败：${error instanceof Error ? error.message : String(error)}`,
    })
    return []
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR'),
  )
}
