import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, open, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import {
  MCP_CONFIG_VERSION,
  formatMcpConfigError,
  parseMcpConfig,
  type ParsedMcpConfig,
  type ParsedMcpServer,
} from './config-schema.ts'

export { MCP_CONFIG_VERSION } from './config-schema.ts'
export const MCP_GLOBAL_CONFIG_TEMPLATE = `${JSON.stringify({
  version: MCP_CONFIG_VERSION,
  servers: {
    'example-local': {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
      enabled: false,
    },
    'example-remote': {
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: {
        Authorization: 'Bearer ${MCP_EXAMPLE_TOKEN}',
      },
      enabled: false,
    },
  },
}, null, 2)}\n`

const MCP_CONFIG_MAX_BYTES = 256 * 1024
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

export interface McpConfiguration {
  servers: McpServerConfig[]
  diagnostics: McpConfigDiagnostic[]
  projectConfigDigest: string | null
  projectServerCount: number
}

export function getProjectMcpConfigPath(projectDir: string): string {
  return join(projectDir, '.whycode', 'mcp.json')
}

export async function ensureMcpConfigTemplate(path: string): Promise<void> {
  try {
    await access(path, constants.F_OK)
    return
  } catch {
    // 缺失时创建；已有但暂时不可读的文件不能被覆盖。
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const handle = await open(path, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') return null
    throw error
  })
  if (!handle) return
  try {
    await handle.writeFile(MCP_GLOBAL_CONFIG_TEMPLATE, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
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
  for (const name of project.declaredServerNames) effective.delete(name)
  for (const server of project.servers) effective.set(server.name, server)
  const servers = [...effective.values()]
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
    diagnostics,
    projectConfigDigest: project.digest,
    projectServerCount: servers.filter((server) => server.scope === 'project').length,
  }
}

interface ConfigReadResult {
  servers: McpServerConfig[]
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
    const info = await stat(path)
    if (!info.isFile() || info.size > MCP_CONFIG_MAX_BYTES) {
      throw new Error(
        info.size > MCP_CONFIG_MAX_BYTES
          ? `配置超过 ${MCP_CONFIG_MAX_BYTES / 1024} KiB`
          : '配置不是普通文件',
      )
    }
    bytes = await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyReadResult()
    return {
      servers: [],
      declaredServerNames: [],
      diagnostics: [{ scope, message: safeError(error) }],
      digest: null,
    }
  }

  const digest = sha256(bytes)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return {
      servers: [],
      declaredServerNames: [],
      diagnostics: [{ scope, message: '配置必须是有效的 UTF-8 文本' }],
      digest,
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return {
      servers: [],
      declaredServerNames: [],
      diagnostics: [{ scope, message: '配置不是合法 JSON' }],
      digest,
    }
  }
  const declaredServerNames = findDeclaredServerNames(raw)
  let parsed: ParsedMcpConfig
  try {
    parsed = parseMcpConfig(raw)
  } catch (error) {
    return {
      servers: [],
      declaredServerNames,
      diagnostics: [{ scope, message: formatMcpConfigError(error) }],
      digest,
    }
  }

  const servers: McpServerConfig[] = []
  const diagnostics: McpConfigDiagnostic[] = []
  for (const [name, value] of Object.entries(parsed.servers)) {
    if (!value.enabled) continue
    try {
      servers.push(resolveServer(name, scope, baseDir, value, env))
    } catch (error) {
      diagnostics.push({ scope, server: name, message: safeError(error) })
    }
  }
  return {
    servers,
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

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function emptyReadResult(): ConfigReadResult {
  return { servers: [], declaredServerNames: [], diagnostics: [], digest: null }
}

function findDeclaredServerNames(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const servers = (value as Record<string, unknown>).servers
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return []
  return Object.keys(servers).map((name) => name.trim()).filter(Boolean)
}
