import {
  MCP_CONFIG_VERSION,
  formatMcpConfigError,
  parseMcpConfig,
  type McpServerConfigInput,
} from './config-schema.ts'
import {
  decodeMcpConfig,
  readMcpConfigBytes,
  writeMcpConfig,
} from './config-storage.ts'

export async function setMcpServerEnabled(
  path: string,
  name: string,
  enabled: boolean,
): Promise<void> {
  const raw = await readMutableMcpConfig(path, false)
  const servers = recordField(raw, 'servers')
  const current = servers[name]
  if (!isRecord(current)) throw new Error(`MCP 服务器不存在：${name}`)
  const next = structuredClone(raw)
  recordField(next, 'servers')[name] = { ...current, enabled }
  validateMcpConfig(next)
  await writeMcpConfig(path, next)
}

export async function addMcpServer(
  path: string,
  name: string,
  server: McpServerConfigInput,
): Promise<void> {
  const raw = await readMutableMcpConfig(path, true)
  const servers = recordField(raw, 'servers')
  if (Object.hasOwn(servers, name)) throw new Error(`MCP 服务器名称已存在：${name}`)
  const next = structuredClone(raw)
  recordField(next, 'servers')[name] = server
  validateMcpConfig(next)
  await writeMcpConfig(path, next)
}

export async function ensureMcpServers(
  path: string,
  defaults: Readonly<Record<string, McpServerConfigInput>>,
): Promise<void> {
  const raw = await readMutableMcpConfig(path, false)
  const servers = recordField(raw, 'servers')
  const missing = Object.entries(defaults).filter(([name]) => !Object.hasOwn(servers, name))
  if (missing.length === 0) return
  const next = structuredClone(raw)
  const nextServers = recordField(next, 'servers')
  for (const [name, server] of missing) nextServers[name] = server
  validateMcpConfig(next)
  await writeMcpConfig(path, next)
}

async function readMutableMcpConfig(
  path: string,
  allowMissing: boolean,
): Promise<Record<string, unknown>> {
  let bytes: Buffer
  try {
    bytes = await readMcpConfigBytes(path)
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: MCP_CONFIG_VERSION, servers: {} }
    }
    throw error
  }
  const decoded = decodeMcpConfig(bytes)
  if (!decoded.ok) throw new Error(decoded.error)
  validateMcpConfig(decoded.value)
  if (!isRecord(decoded.value)) throw new Error('MCP 配置必须是 JSON 对象')
  return decoded.value
}

function recordField(value: Record<string, unknown>, name: string): Record<string, unknown> {
  const field = value[name]
  if (!isRecord(field)) throw new Error(`MCP 配置字段无效：${name}`)
  return field
}

function validateMcpConfig(value: unknown): void {
  try {
    parseMcpConfig(value)
  } catch (error) {
    throw new Error(formatMcpConfigError(error))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
