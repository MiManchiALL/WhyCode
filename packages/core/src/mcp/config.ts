import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  MCP_CONFIG_VERSION,
  formatMcpConfigError,
  parseMcpConfig,
  parseMcpSecretHeader,
  type McpSecretHeader,
  type ParsedMcpConfig,
  type ParsedMcpServer,
} from './config-schema.ts'
import {
  decodeMcpConfig,
  ensureMcpFile,
  readMcpConfigBytes,
} from './config-storage.ts'

export { MCP_CONFIG_VERSION } from './config-schema.ts'
export type { McpSecretHeader } from './config-schema.ts'
export { addMcpServer, setMcpServerEnabled } from './config-mutations.ts'
import { ensureMcpServers } from './config-mutations.ts'

export const MCP_CONTEXT7_BUILTIN = {
  id: 'context7',
  name: 'context7',
  capabilitySummary: '查询最新的第三方库与框架文档、API 和示例；适合需要核对当前版本用法的技术问题。',
  server: {
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    enabled: true,
  },
  secretHeaderName: 'CONTEXT7_API_KEY',
} as const
export const MCP_GITHUB_BUILTIN = {
  id: 'github',
  name: 'github',
  capabilitySummary: '读取 GitHub 仓库、文件、提交、Issue 和 Pull Request 等结构化数据；配置认证后可访问凭据有权读取的私有资源。',
  server: {
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/readonly',
    headers: {
      'X-MCP-Readonly': 'true',
    },
    enabled: true,
  },
  secretHeaderName: 'Authorization',
} as const
export type McpBuiltinServerId =
  | typeof MCP_CONTEXT7_BUILTIN.id
  | typeof MCP_GITHUB_BUILTIN.id

export function getMcpBuiltinCapabilitySummary(
  id: McpBuiltinServerId | undefined,
): string | undefined {
  if (id === MCP_CONTEXT7_BUILTIN.id) return MCP_CONTEXT7_BUILTIN.capabilitySummary
  if (id === MCP_GITHUB_BUILTIN.id) return MCP_GITHUB_BUILTIN.capabilitySummary
  return undefined
}

const MCP_GLOBAL_DEFAULT_SERVERS = {
  [MCP_CONTEXT7_BUILTIN.name]: MCP_CONTEXT7_BUILTIN.server,
  [MCP_GITHUB_BUILTIN.name]: MCP_GITHUB_BUILTIN.server,
} as const
export const MCP_GLOBAL_CONFIG_TEMPLATE = `${JSON.stringify({
  version: MCP_CONFIG_VERSION,
  servers: MCP_GLOBAL_DEFAULT_SERVERS,
}, null, 2)}\n`
export const MCP_PROJECT_CONFIG_TEMPLATE = `${JSON.stringify({
  version: MCP_CONFIG_VERSION,
  servers: {},
}, null, 2)}\n`

const MCP_MAX_SERVERS = 32
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

export type McpConfigScope = 'global' | 'project'

interface McpServerConfigBase {
  name: string
  scope: McpConfigScope
  sourceFingerprint: string
  startupTimeoutMs: number
  toolTimeoutMs: number
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  transport: 'stdio'
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  transport: 'http'
  url: string
  headers: Record<string, string>
  connectionFingerprint: string
  builtinId?: McpBuiltinServerId
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig

export interface McpConfigDiagnostic {
  scope: McpConfigScope
  server?: string
  message: string
}

export interface McpConfiguredServer {
  name: string
  scope: McpConfigScope
  transport: 'stdio' | 'http'
  enabled: boolean
  /** 只绑定传输目标，不包含密钥；Main 用于防止 URL 改变后向新端点发送旧凭据。 */
  connectionFingerprint?: string
  /** 项目同名条目会完整覆盖全局条目，包括禁用和无效配置。 */
  effective: boolean
  builtinId?: McpBuiltinServerId
}

export interface McpConfiguration {
  servers: McpServerConfig[]
  configuredServers: McpConfiguredServer[]
  diagnostics: McpConfigDiagnostic[]
  projectConfigDigest: string | null
  projectServerCount: number
}

export function getProjectMcpConfigPath(projectDir: string): string {
  return join(projectDir, '.whycode', 'mcp.json')
}

export async function ensureMcpConfigTemplate(path: string): Promise<void> {
  await ensureMcpFile(path, MCP_GLOBAL_CONFIG_TEMPLATE)
  await ensureMcpServers(path, MCP_GLOBAL_DEFAULT_SERVERS)
}

export async function ensureProjectMcpConfigTemplate(path: string): Promise<void> {
  await ensureMcpFile(path, MCP_PROJECT_CONFIG_TEMPLATE)
}

export async function loadMcpConfiguration(options: {
  globalConfigPath: string
  projectDir?: string | null
  env?: NodeJS.ProcessEnv
  /** 由宿主安全存储解密；只叠加到全局 HTTP 服务器，不进入配置摘要。 */
  globalSecretHeaders?: readonly McpSecretHeader[]
}): Promise<McpConfiguration> {
  const env = options.env ?? process.env
  const globalSecretHeaders = groupSecretHeaders(options.globalSecretHeaders ?? [])
  const global = await readConfigFile('global', options.globalConfigPath, dirname(
    options.globalConfigPath,
  ), env, globalSecretHeaders)
  const projectPath = options.projectDir
    ? getProjectMcpConfigPath(options.projectDir)
    : null
  const project = projectPath
    ? await readConfigFile('project', projectPath, options.projectDir!, env, EMPTY_HEADERS)
    : emptyReadResult()
  const effective = new Map<string, McpServerConfig>()
  for (const server of global.servers) effective.set(server.name, server)
  const projectNames = new Set(project.declaredServerNames)
  for (const name of projectNames) effective.delete(name)
  for (const server of project.servers) effective.set(server.name, server)
  const servers = [...effective.values()]
  const configuredServers = [
    ...global.configuredServers.map((server) => ({
      ...server,
      effective: !projectNames.has(server.name),
    })),
    ...project.configuredServers.map((server) => ({ ...server, effective: true })),
  ]
  const diagnostics = [...global.diagnostics, ...project.diagnostics]
  if (servers.length > MCP_MAX_SERVERS) {
    diagnostics.push({
      scope: 'global',
      message: `有效 MCP 服务器数量超过上限 ${MCP_MAX_SERVERS}`,
    })
    servers.length = MCP_MAX_SERVERS
  }
  return {
    servers,
    configuredServers,
    diagnostics,
    projectConfigDigest: project.digest,
    projectServerCount: servers.filter((server) => server.scope === 'project').length,
  }
}

interface ConfigReadResult {
  servers: McpServerConfig[]
  configuredServers: Omit<McpConfiguredServer, 'effective'>[]
  declaredServerNames: string[]
  diagnostics: McpConfigDiagnostic[]
  digest: string | null
}

async function readConfigFile(
  scope: McpConfigScope,
  path: string,
  baseDir: string,
  env: NodeJS.ProcessEnv,
  secretHeaders: ReadonlyMap<string, Readonly<Record<string, string>>>,
): Promise<ConfigReadResult> {
  let bytes: Buffer
  try {
    bytes = await readMcpConfigBytes(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyReadResult()
    return {
      servers: [],
      configuredServers: [],
      declaredServerNames: [],
      diagnostics: [{ scope, message: safeError(error) }],
      digest: null,
    }
  }

  const digest = sha256(bytes)
  const decoded = decodeMcpConfig(bytes)
  if (!decoded.ok) {
    return {
      servers: [],
      configuredServers: [],
      declaredServerNames: [],
      diagnostics: [{ scope, message: decoded.error }],
      digest,
    }
  }
  const raw = decoded.value
  const declaredServerNames = findDeclaredServerNames(raw)
  let parsed: ParsedMcpConfig
  try {
    parsed = parseMcpConfig(raw)
  } catch (error) {
    return {
      servers: [],
      configuredServers: [],
      declaredServerNames,
      diagnostics: [{ scope, message: formatMcpConfigError(error) }],
      digest,
    }
  }

  const servers: McpServerConfig[] = []
  const configuredServers: Omit<McpConfiguredServer, 'effective'>[] = []
  const diagnostics: McpConfigDiagnostic[] = []
  for (const [name, value] of Object.entries(parsed.servers)) {
    const fingerprint = value.transport === 'http'
      ? connectionFingerprint(value)
      : undefined
    configuredServers.push({
      name,
      scope,
      transport: value.transport,
      enabled: value.enabled,
      ...(fingerprint ? { connectionFingerprint: fingerprint } : {}),
      ...configuredBuiltin(name, value),
    })
    if (!value.enabled) continue
    try {
      servers.push(resolveServer(
        name,
        scope,
        baseDir,
        value,
        env,
        fingerprint
          ? secretHeaders.get(secretHeaderTargetKey(name, fingerprint))
          : undefined,
      ))
    } catch (error) {
      diagnostics.push({ scope, server: name, message: safeError(error) })
    }
  }
  return {
    servers,
    configuredServers,
    declaredServerNames,
    diagnostics,
    digest,
  }
}

function resolveServer(
  name: string,
  scope: McpConfigScope,
  baseDir: string,
  value: ParsedMcpServer,
  env: NodeJS.ProcessEnv,
  secretHeaders?: Readonly<Record<string, string>>,
): McpServerConfig {
  const sourceFingerprint = sha256(JSON.stringify(value))
  if (value.transport === 'stdio') {
    return {
      name,
      scope,
      sourceFingerprint,
      transport: 'stdio',
      command: value.command,
      args: value.args,
      cwd: value.cwd
        ? isAbsolute(value.cwd) ? resolve(value.cwd) : resolve(baseDir, value.cwd)
        : resolve(baseDir),
      env: resolveRecord(value.env ?? {}, env),
      startupTimeoutMs: value.startupTimeoutMs,
      toolTimeoutMs: value.toolTimeoutMs,
    }
  }
  return {
    name,
    scope,
    sourceFingerprint,
    transport: 'http',
    url: value.url,
    headers: mergeHeaders(resolveRecord(value.headers ?? {}, env), secretHeaders),
    connectionFingerprint: connectionFingerprint(value),
    ...configuredBuiltin(name, value),
    startupTimeoutMs: value.startupTimeoutMs,
    toolTimeoutMs: value.toolTimeoutMs,
  }
}

function resolveRecord(
  values: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    value.replace(ENV_REFERENCE, (_match, name: string) => {
      const resolved = env[name]
      if (resolved === undefined) throw new Error(`环境变量 ${name} 未设置`)
      return resolved
    }),
  ]))
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/[\r\n]+/gu, ' ').slice(0, 500)
}

const EMPTY_HEADERS = new Map<string, Readonly<Record<string, string>>>()

function groupSecretHeaders(
  values: readonly McpSecretHeader[],
): Map<string, Readonly<Record<string, string>>> {
  const grouped = new Map<string, Record<string, string>>()
  for (const value of values) {
    const parsed = parseMcpSecretHeader(value)
    const targetKey = secretHeaderTargetKey(
      parsed.serverName,
      parsed.connectionFingerprint,
    )
    const headers = grouped.get(targetKey) ?? Object.create(null) as Record<string, string>
    const duplicate = Object.keys(headers).find((name) =>
      name.toLowerCase() === parsed.headerName.toLowerCase())
    if (duplicate) delete headers[duplicate]
    headers[parsed.headerName] = parsed.value
    grouped.set(targetKey, headers)
  }
  return grouped
}

function mergeHeaders(
  configured: Record<string, string>,
  secrets?: Readonly<Record<string, string>>,
): Record<string, string> {
  if (!secrets) return configured
  const merged = { ...configured }
  for (const [name, value] of Object.entries(secrets)) {
    const duplicate = Object.keys(merged).find((existing) =>
      existing.toLowerCase() === name.toLowerCase())
    if (duplicate) delete merged[duplicate]
    merged[name] = value
  }
  return merged
}

function connectionFingerprint(server: Extract<ParsedMcpServer, { transport: 'http' }>): string {
  return sha256(JSON.stringify({ transport: server.transport, url: server.url }))
}

function secretHeaderTargetKey(serverName: string, fingerprint: string): string {
  return `${serverName}\u0000${fingerprint}`
}

function configuredBuiltin(
  name: string,
  server: ParsedMcpServer,
): { builtinId?: McpBuiltinServerId } {
  if (server.transport !== 'http') return {}
  if (
    name === MCP_CONTEXT7_BUILTIN.name
    && server.url === MCP_CONTEXT7_BUILTIN.server.url
  ) return { builtinId: MCP_CONTEXT7_BUILTIN.id }
  if (
    name === MCP_GITHUB_BUILTIN.name
    && server.url === MCP_GITHUB_BUILTIN.server.url
  ) return { builtinId: MCP_GITHUB_BUILTIN.id }
  return {}
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function emptyReadResult(): ConfigReadResult {
  return {
    servers: [],
    configuredServers: [],
    declaredServerNames: [],
    diagnostics: [],
    digest: null,
  }
}

function findDeclaredServerNames(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const servers = (value as Record<string, unknown>).servers
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return []
  return Object.keys(servers).map((name) => name.trim()).filter(Boolean)
}
