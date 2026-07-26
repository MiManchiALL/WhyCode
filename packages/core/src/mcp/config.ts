import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  MCP_CONFIG_VERSION,
  formatMcpConfigError,
  parseMcpConfig,
  type ParsedMcpConfig,
  type ParsedMcpServer,
} from './config-schema.ts'
import {
  decodeMcpConfig,
  ensureMcpFile,
  readMcpConfigBytes,
} from './config-storage.ts'

export { MCP_CONFIG_VERSION } from './config-schema.ts'
export { addMcpServer, setMcpServerEnabled } from './config-mutations.ts'
export const MCP_CONTEXT7_PRESET = {
  id: 'context7',
  name: 'context7',
  server: {
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    enabled: false,
  },
} as const
export const MCP_GLOBAL_CONFIG_TEMPLATE = `${JSON.stringify({
  version: MCP_CONFIG_VERSION,
  servers: {
    [MCP_CONTEXT7_PRESET.name]: MCP_CONTEXT7_PRESET.server,
  },
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
  /** 项目同名条目会完整覆盖全局条目，包括禁用和无效配置。 */
  effective: boolean
  presetId?: typeof MCP_CONTEXT7_PRESET.id
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
}

export async function ensureProjectMcpConfigTemplate(path: string): Promise<void> {
  await ensureMcpFile(path, MCP_PROJECT_CONFIG_TEMPLATE)
}

export async function loadMcpConfiguration(options: {
  globalConfigPath: string
  projectDir?: string | null
  env?: NodeJS.ProcessEnv
}): Promise<McpConfiguration> {
  const env = options.env ?? process.env
  const global = await readConfigFile('global', options.globalConfigPath, dirname(
    options.globalConfigPath,
  ), env)
  const projectPath = options.projectDir
    ? getProjectMcpConfigPath(options.projectDir)
    : null
  const project = projectPath
    ? await readConfigFile('project', projectPath, options.projectDir!, env)
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
    configuredServers.push({
      name,
      scope,
      transport: value.transport,
      enabled: value.enabled,
      ...(isContext7Preset(name, value) ? { presetId: MCP_CONTEXT7_PRESET.id } : {}),
    })
    if (!value.enabled) continue
    try {
      servers.push(resolveServer(name, scope, baseDir, value, env))
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
    headers: resolveRecord(value.headers ?? {}, env),
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

function isContext7Preset(name: string, server: ParsedMcpServer): boolean {
  return (
    name === MCP_CONTEXT7_PRESET.name
    && server.transport === 'http'
    && server.url === MCP_CONTEXT7_PRESET.server.url
  )
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
