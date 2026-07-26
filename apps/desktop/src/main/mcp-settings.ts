import {
  MCP_CONTEXT7_PRESET,
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
  EnableMcpPresetRequest,
  McpSettingsItem,
  SaveMcpSecretHeaderRequest,
  SetMcpServerEnabledRequest,
} from '../shared/settings.ts'
import type { WhycodeConfig } from './config.ts'

interface McpSettingsContext {
  globalConfigPath: string
  projectDir: string | null
  currentSessionSnapshot: McpManagerSnapshot | null
  mcpSecretHeaders: readonly McpSecretHeader[]
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
  const globalContext7 = configuration.configuredServers.find((server) =>
    server.scope === 'global' && server.name === MCP_CONTEXT7_PRESET.name)

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
        return {
          name: server.name,
          scope: server.scope,
          transport: server.transport,
          enabled: server.enabled,
          effective: server.effective,
          ...(server.presetId ? { presetId: server.presetId } : {}),
          secretHeaderNames,
          ...(server.presetId === MCP_CONTEXT7_PRESET.id
            ? { suggestedSecretHeaderName: MCP_CONTEXT7_PRESET.secretHeaderName }
            : {}),
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
    recommendedPresets: [{
      id: MCP_CONTEXT7_PRESET.id,
      displayName: 'Context7',
      description: '按库和版本检索最新开发文档；使用官方远程 MCP，无需本地运行 Node 服务。',
      status: globalContext7?.presetId === MCP_CONTEXT7_PRESET.id
        ? 'installed'
        : globalContext7
          ? 'name-conflict'
          : 'available',
    }],
  }
}

export async function updateMcpServerState(
  context: Pick<McpSettingsContext, 'globalConfigPath' | 'projectDir'>,
  request: SetMcpServerEnabledRequest,
): Promise<void> {
  await setMcpServerEnabled(configPath(context, request.scope), request.name, request.enabled)
}

export async function enableMcpPreset(
  globalConfigPath: string,
  request: EnableMcpPresetRequest,
): Promise<void> {
  if (request.presetId !== MCP_CONTEXT7_PRESET.id) {
    throw new Error('未知的 MCP 推荐预设')
  }
  await addMcpServer(
    globalConfigPath,
    MCP_CONTEXT7_PRESET.name,
    MCP_CONTEXT7_PRESET.server,
  )
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
    const secret = request.secret?.trim() ?? ''
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
