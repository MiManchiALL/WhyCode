import { localWorkspaceIO, type WorkspaceIO, type WorkspaceDirent } from '../workspace/io.ts'
import { join, resolve } from 'node:path'
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
const FRONTMATTER_RE = /^---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/
const AGENT_METADATA_KEYS = new Set(['name', 'description', 'profile'])

const PROFILE_TOOLS: Record<SubagentProfile, readonly string[]> = {
  explore: [
    'ReadFile', 'ListDir', 'Glob', 'Grep',
    'WebSearch', 'WebFetch', 'WebFind', 'Skill',
    'CaptureScreenshot',
  ],
  reviewer: [
    'ReadFile', 'ListDir', 'Glob', 'Grep', 'RunCommand',
    'WebSearch', 'WebFetch', 'WebFind', 'Skill',
    'CaptureScreenshot',
  ],
  general: [
    'ReadFile', 'ListDir', 'Glob', 'Grep', 'WriteFile', 'EditFile', 'DeleteFile',
    'RunCommand', 'WebSearch', 'WebFetch', 'WebFind', 'CaptureScreenshot', 'Skill',
  ],
}

const BUILTIN_DEFINITIONS: readonly SubagentDefinitionSnapshot[] = [
  builtin(
    'explore',
    '用于跨多处、命名方式或来源的只读调查，形成可定位、基于证据的结论。',
    [
      '你负责定位事实、文件和调用关系，为父代理提供可核实的调查结论。',
      '已知路径或符号时直接读取；位置不明时从宽到窄搜索，交叉检查不同命名、入口与调用方。按委派要求控制调查深度，独立读取可并行。',
      '核实关键证据后即可交付，不把调查扩大为实现或全面审计；只读分析，不修改项目。',
      '报告结论、精确文件位置或来源、关键调用关系与未确认之处；不输出搜索流水账或大段文件转录。',
    ].join('\n'),
  ),
  builtin(
    'reviewer',
    '用于实现后的独立审查和验证；运行必要命令，报告可行动问题、风险与覆盖范围。',
    [
      '你负责独立审查和验证，检查实际实现是否满足委派目标，而不是复述实现者的结论。',
      '阅读相关改动、完整职责、调用方与测试，沿真实输入追踪可疑行为；检查问题是否已在其它边界处理，区分缺陷、明确取舍与推测。',
      '运行与风险相称的定向验证，核对实际输出及可观察行为；未执行的检查不能写成通过。',
      '可以运行验证命令，但不得修改、删除或移动被审查的项目内容，不自动修复问题；必要临时验证产物只放自己的临时工作区并清理。',
      '优先报告含严重度、位置、触发条件、证据和影响的可行动问题；无问题时明确说明，并交代验证范围与盲区。',
    ].join('\n'),
  ),
  builtin(
    'general',
    '用于边界明确、可独立交付的实现、调研或验证任务。',
    [
      '你负责独立完成边界明确的委派，交付父代理可直接使用的结果。',
      '先确认目标、范围和验收标准，读取相关实现与调用方，优先复用已有能力。委派只要求分析时给出分析；明确要求实施时完成必要修改。',
      '沿根因完成最小必要改动，保留已有工作，不顺手扩展范围；用定向验证核对交付行为，不留半成品，也不额外扩展。',
      '非交付的脚本、日志和其它临时产物放在自己的临时工作区，并清理自己创建的资源。',
      '最终报告完成的成果或改动、关键证据、实际验证结果和遗留风险；遇到权限或必要信息缺失时，交代父代理可接手的具体事项。',
    ].join('\n'),
  ),
]

export interface SubagentDefinitionCatalogOptions {
  homeDir?: string
}

/** 请求边界读取有界目录；本次请求和随后启动的实例共用这份定义。 */
export class SubagentDefinitionCatalogService {
  private readonly homeDir: string | undefined

  constructor(options: SubagentDefinitionCatalogOptions = {}) {
    this.homeDir = options.homeDir ? resolve(options.homeDir) : undefined
  }

  async snapshot(projectDir: string | null, workspaceIO: WorkspaceIO = localWorkspaceIO): Promise<SubagentDefinitionCatalogSnapshot> {
    const diagnostics: SubagentDefinitionDiagnostic[] = []
    const definitions = new Map<string, SubagentDefinitionSnapshot>(
      BUILTIN_DEFINITIONS.map((definition) => [definition.name, structuredClone(definition)]),
    )
    const conflicts = new Set<string>()
    const roots: Array<{ path: string; scope: Exclude<SubagentDefinitionScope, 'builtin'>; io: WorkspaceIO }> = []
    if (this.homeDir) roots.push({ path: join(this.homeDir, '.whycode', 'agents'), scope: 'user', io: localWorkspaceIO })
    if (projectDir) {
      const path = workspaceIO.path.join(workspaceIO.path.resolve(projectDir), '.whycode', 'agents')
      const alreadyIncluded = roots.some(root => root.io.identity === workspaceIO.identity
        && workspaceIO.path.relative(root.path, path) === '')
      if (!alreadyIncluded) roots.push({ path, scope: 'project', io: workspaceIO })
    }

    for (const root of roots) {
      const entries = await readAgentDirectory(root.path, diagnostics, root.io)
      let loadedBytes = 0
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MAX_AGENT_FILES_PER_ROOT)
      for (const file of files) {
        const path = root.io.path.join(root.path, file.name)
        try {
          const definition = await loadCustomDefinition(path, root.scope, root.io)
          const cost = Buffer.byteLength(definition.instructions, 'utf8')
          if (loadedBytes + cost > MAX_AGENT_BYTES_PER_ROOT) {
            diagnostics.push({
              path: root.path,
              message: `Agent 定义正文达到 ${MAX_AGENT_BYTES_PER_ROOT} 字节总预算，后续项已省略`,
            })
            break
          }
          loadedBytes += cost
          const previous = definitions.get(definition.name)
          if (previous || conflicts.has(definition.name)) {
            diagnostics.push({ path, message: `子代理 name 重复：${definition.name}${previous ? `（已存在于 ${previous.sourcePath ?? '内置目录'}）` : ''}` })
            if (previous?.scope !== 'builtin') {
              definitions.delete(definition.name)
              conflicts.add(definition.name)
            }
            continue
          }
          definitions.set(definition.name, definition)
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

    return {
      definitions: [...definitions.values()].sort((left, right) => left.name.localeCompare(right.name)),
      diagnostics,
    }
  }
}

function builtin(
  name: SubagentProfile,
  description: string,
  instructions: string,
): SubagentDefinitionSnapshot {
  return subagentDefinitionSnapshotSchema.parse({
    name,
    description,
    profile: name,
    scope: 'builtin',
    instructions,
    toolNames: PROFILE_TOOLS[name],
  })
}

async function loadCustomDefinition(
  path: string,
  scope: Exclude<SubagentDefinitionScope, 'builtin'>,
  io: WorkspaceIO,
): Promise<SubagentDefinitionSnapshot> {
  const info = await io.fs.lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Agent 定义必须是普通文件且不能是符号链接')
  }
  if (info.size > MAX_AGENT_FILE_BYTES) {
    throw new Error(`Agent 定义超过 ${MAX_AGENT_FILE_BYTES} 字节上限`)
  }
  const bytes = await io.fs.readFile(path)
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
  if (io.path.basename(path, '.md') !== name) throw new Error('name 必须与 Markdown 文件名一致')
  const description = requiredString(metadata, 'description')
  const profile = subagentProfileSchema.parse(metadata.profile ?? 'general')
  const instructions = content.slice(frontmatter[0].length).trim()
  return subagentDefinitionSnapshotSchema.parse({
    name,
    description,
    profile,
    scope,
    instructions,
    toolNames: PROFILE_TOOLS[profile],
    sourcePath: io.path.resolve(path),
  })
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || !field.trim()) throw new Error(`${key} 必须是非空字符串`)
  return field.trim()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

async function readAgentDirectory(
  path: string,
  diagnostics: SubagentDefinitionDiagnostic[],
  io: WorkspaceIO,
): Promise<WorkspaceDirent[]> {
  try {
    const info = await io.fs.lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      diagnostics.push({ path, message: 'Agent 根路径必须是普通目录且不能是符号链接' })
      return []
    }
    return await io.fs.readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return []
    throw new Error(`Agent 根目录读取失败：${path}`, { cause: error })
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
