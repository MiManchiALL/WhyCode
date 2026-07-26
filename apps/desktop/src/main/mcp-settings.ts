import {
  MCP_CONTEXT7_PRESET,
  addMcpServer,
  getProjectMcpConfigPath,
  loadMcpConfiguration,
  setMcpServerEnabled,
  type McpConfigScope,
  type McpManagerSnapshot,
} from '@whycode/core'
import type {
  EnableMcpPresetRequest,
  McpSettingsItem,
  SetMcpServerEnabledRequest,
} from '../shared/settings.ts'

interface McpSettingsContext {
  globalConfigPath: string
  projectDir: string | null
  currentSessionSnapshot: McpManagerSnapshot | null
}

export async function createMcpSettingsSnapshot(
  context: McpSettingsContext,
): Promise<McpSettingsItem> {
  const configuration = await loadMcpConfiguration({
    globalConfigPath: context.globalConfigPath,
    projectDir: context.projectDir,
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
        return {
          ...server,
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
  await addMcpServer(globalConfigPath, MCP_CONTEXT7_PRESET.name, {
    ...MCP_CONTEXT7_PRESET.server,
    enabled: true,
  })
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
