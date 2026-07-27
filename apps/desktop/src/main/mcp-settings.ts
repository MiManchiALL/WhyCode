import {
  MCP_CONTEXT7_BUILTIN,
  MCP_GITHUB_BUILTIN,
  addMcpServer,
  getProjectMcpConfigPath,
  loadMcpConfiguration,
  parseMcpSecretHeader,
  setMcpServerEnabled,
  type McpConfigScope,
  type McpManagerSnapshot,
  type McpSecretHeader,
} from '@whycode/core'
import type {
  AddMcpServerRequest,
  McpSettingsItem,
  SaveMcpSecretHeaderRequest,
  SetMcpServerEnabledRequest,
} from '../shared/settings.ts'
import type { WhycodeConfig } from './config.ts'
import type { McpOAuthController } from './mcp-oauth.ts'

interface McpSettingsContext {
  globalConfigPath: string
  projectDir: string | null
  currentSessionSnapshot: McpManagerSnapshot | null
  mcpSecretHeaders: readonly McpSecretHeader[]
  mcpOAuthController?: McpOAuthController
}

export async function createMcpSettingsSnapshot(
  context: McpSettingsContext,
): Promise<McpSettingsItem> {
  const configuration = await loadMcpConfiguration({
    globalConfigPath: context.globalConfigPath,
    projectDir: context.projectDir,
    globalSecretHeaders: context.mcpSecretHeaders,
  })
  const currentStatuses = new Map(
    (context.currentSessionSnapshot?.servers ?? []).map((server) => [
      serverKey(server.scope, server.name),
      server,
    ]),
  )
  return {
    globalConfigPath: context.globalConfigPath,
    ...(context.projectDir
      ? { projectConfigPath: getProjectMcpConfigPath(context.projectDir) }
      : {}),
    currentSessionUsesSnapshot: context.currentSessionSnapshot !== null,
    servers: configuration.configuredServers
      .map((server) => {
        const current = currentStatuses.get(serverKey(server.scope, server.name))
        const secretHeaderNames = server.scope === 'global' && server.connectionFingerprint
          ? context.mcpSecretHeaders
            .filter((entry) =>
              entry.serverName === server.name
              && entry.connectionFingerprint === server.connectionFingerprint)
            .map((entry) => entry.headerName)
            .sort((left, right) => left.localeCompare(right))
          : []
        const resolved = configuration.servers.find((candidate) =>
          candidate.scope === server.scope && candidate.name === server.name)
        const oauth = resolved?.transport === 'http'
          && server.scope === 'global'
          && server.builtinId !== MCP_CONTEXT7_BUILTIN.id
          && context.mcpOAuthController
          && !hasAuthorizationHeader(resolved.headers)
          ? context.mcpOAuthController.availability(resolved)
          : undefined
        return {
          name: server.name,
          scope: server.scope,
          transport: server.transport,
          enabled: server.enabled,
          effective: server.effective,
          ...(server.builtinId ? { builtinId: server.builtinId } : {}),
          secretHeaderNames,
          ...(server.builtinId === MCP_CONTEXT7_BUILTIN.id
            ? {
                suggestedSecretHeaderName: MCP_CONTEXT7_BUILTIN.secretHeaderName,
                suggestedSecretKind: 'api-key' as const,
              }
            : server.builtinId === MCP_GITHUB_BUILTIN.id
              ? {
                  suggestedSecretHeaderName: MCP_GITHUB_BUILTIN.secretHeaderName,
                  suggestedSecretKind: 'github-pat' as const,
                }
            : {}),
          ...(oauth ? { oauth } : {}),
          ...(current ? {
            currentSessionState: current.state,
            currentSessionToolCount: current.toolCount,
            ...(current.error ? { currentSessionError: current.error } : {}),
          } : {}),
          currentSessionDiagnostics: [...(current?.diagnostics ?? [])],
        }
      })
      .sort(compareServers),
    diagnostics: configuration.diagnostics,
  }
}

export async function updateMcpServerState(
  context: Pick<McpSettingsContext, 'globalConfigPath' | 'projectDir'>,
  request: SetMcpServerEnabledRequest,
): Promise<void> {
  await setMcpServerEnabled(configPath(context, request.scope), request.name, request.enabled)
}

export async function addMcpConfiguredServer(
  context: Pick<McpSettingsContext, 'globalConfigPath' | 'projectDir'>,
  request: AddMcpServerRequest,
): Promise<void> {
  const name = request.name.trim()
  const server = request.server.transport === 'http'
    ? {
        transport: 'http' as const,
        url: request.server.url.trim(),
        enabled: true,
      }
    : {
        transport: 'stdio' as const,
        command: request.server.command.trim(),
        args: request.server.args.map((argument) => argument.trim()).filter(Boolean),
        ...(request.server.cwd?.trim() ? { cwd: request.server.cwd.trim() } : {}),
        enabled: true,
      }
  await addMcpServer(configPath(context, request.scope), name, server)
}

export async function updateMcpSecretHeader(
  context: Pick<McpSettingsContext, 'globalConfigPath' | 'projectDir'>,
  config: WhycodeConfig | null,
  request: SaveMcpSecretHeaderRequest,
): Promise<WhycodeConfig> {
  if (request.scope !== 'global') {
    throw new Error('项目 MCP 的密钥请使用项目环境变量引用，不能写入本机全局密钥库')
  }
  const configuration = await loadMcpConfiguration({
    globalConfigPath: context.globalConfigPath,
    projectDir: context.projectDir,
  })
  const server = configuration.configuredServers.find((candidate) =>
    candidate.scope === 'global' && candidate.name === request.serverName)
  if (!server || server.transport !== 'http' || !server.connectionFingerprint) {
    throw new Error(`全局 Streamable HTTP MCP 服务器不存在：${request.serverName}`)
  }

  const headerName = request.headerName.trim()
  const retained = (config?.mcpSecretHeaders ?? []).filter((entry) =>
    !(
      entry.serverName === server.name
      && entry.headerName.toLowerCase() === headerName.toLowerCase()
    ))
  const next: WhycodeConfig = config ? structuredClone(config) : { providers: {} }
  if (!request.clearSecret) {
    const rawSecret = request.secret?.trim() ?? ''
    if (!rawSecret) throw new Error('MCP 认证值不能为空')
    const secret = server.builtinId === MCP_GITHUB_BUILTIN.id
      && headerName.toLowerCase() === MCP_GITHUB_BUILTIN.secretHeaderName.toLowerCase()
      ? githubBearerValue(rawSecret)
      : rawSecret
    retained.push(parseMcpSecretHeader({
      serverName: server.name,
      connectionFingerprint: server.connectionFingerprint,
      headerName,
      value: secret,
    }))
  }
  if (retained.length > 0) next.mcpSecretHeaders = retained
  else delete next.mcpSecretHeaders
  return next
}

function githubBearerValue(value: string): string {
  const token = value.replace(/^Bearer(?:\s+|$)/iu, '').trim()
  if (!token) throw new Error('GitHub PAT 不能为空')
  return `Bearer ${token}`
}

function hasAuthorizationHeader(headers: Readonly<Record<string, string>>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')
}

export function resolveMcpConfigPath(
  context: Pick<McpSettingsContext, 'globalConfigPath' | 'projectDir'>,
  scope: McpConfigScope,
): string {
  return configPath(context, scope)
}

function configPath(
  context: Pick<McpSettingsContext, 'globalConfigPath' | 'projectDir'>,
  scope: McpConfigScope,
): string {
  if (scope === 'global') return context.globalConfigPath
  if (!context.projectDir) throw new Error('当前没有可用的项目工作文件夹')
  return getProjectMcpConfigPath(context.projectDir)
}

function serverKey(scope: McpConfigScope, name: string): string {
  return `${scope}:${name}`
}

function compareServers(
  left: McpSettingsItem['servers'][number],
  right: McpSettingsItem['servers'][number],
): number {
  if (left.scope !== right.scope) return left.scope === 'global' ? -1 : 1
  return left.name.localeCompare(right.name)
}
