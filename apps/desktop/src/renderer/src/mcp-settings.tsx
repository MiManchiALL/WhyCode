import type {
  AddMcpServerRequest,
  McpOAuthRequest,
  McpSettingsItem,
  OpenMcpConfigRequest,
  SaveMcpSecretHeaderRequest,
  SetMcpServerEnabledRequest,
} from '../../shared/settings.ts'
import { McpAddServer } from './mcp-add-server.tsx'
import { McpOAuthEditor } from './mcp-oauth.tsx'
import { McpSecretHeaderEditor } from './mcp-secret-header.tsx'
import { PaperFrame } from './paper-frame.tsx'

interface McpSettingsEditorProps {
  settings: McpSettingsItem
  disabled: boolean
  onSetEnabled: (request: SetMcpServerEnabledRequest) => Promise<boolean>
  onAddServer: (request: AddMcpServerRequest) => Promise<boolean>
  onSaveSecretHeader: (request: SaveMcpSecretHeaderRequest) => Promise<boolean>
  onAuthorizeOAuth: (request: McpOAuthRequest) => Promise<boolean>
  onDisconnectOAuth: (request: McpOAuthRequest) => Promise<boolean>
  onOpenConfig: (request: OpenMcpConfigRequest) => Promise<void>
  onRefresh: () => Promise<void>
}

export function McpSettingsEditor(props: McpSettingsEditorProps) {
  return (
    <section className="wc-paper-section">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">MCP 服务</h3>
          <p className="text-xs text-neutral-500">
            外部工具按需连接并通过 ToolSearch 延迟加载；启停写入原 MCP 配置，新会话生效。
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            className="wc-focus-ring rounded-xl border border-[var(--wc-line)] bg-white px-2.5 py-1.5 wc-type-caption text-[var(--wc-muted)] disabled:opacity-40"
            onClick={() => void props.onRefresh()}
            disabled={props.disabled}
          >
            刷新状态
          </button>
          <button
            className="wc-focus-ring rounded-xl border border-[var(--wc-line)] bg-white px-2.5 py-1.5 wc-type-caption text-[var(--wc-muted)] disabled:opacity-40"
            onClick={() => void props.onOpenConfig({ scope: 'global' })}
            disabled={props.disabled}
            title={props.settings.globalConfigPath}
          >
            打开全局配置
          </button>
          {props.settings.projectConfigPath && (
            <button
              className="wc-focus-ring rounded-xl border border-[var(--wc-line)] bg-white px-2.5 py-1.5 wc-type-caption text-[var(--wc-muted)] disabled:opacity-40"
              onClick={() => void props.onOpenConfig({ scope: 'project' })}
              disabled={props.disabled}
              title={props.settings.projectConfigPath}
            >
              打开项目配置
            </button>
          )}
        </div>
      </div>

      <McpAddServer
        hasProject={Boolean(props.settings.projectConfigPath)}
        disabled={props.disabled}
        onAdd={props.onAddServer}
      />

      {props.settings.diagnostics.length > 0 && (
        <div className="min-w-0 space-y-1 rounded-xl border border-[#dec8bf] bg-[#f3e8e3] p-3 [overflow-wrap:anywhere]">
          {props.settings.diagnostics.map((diagnostic, index) => (
            <p key={`${diagnostic.scope}:${diagnostic.server ?? ''}:${index}`} className="wc-type-caption text-red-700">
              {scopeLabel(diagnostic.scope)}
              {diagnostic.server ? ` · ${diagnostic.server}` : ''}
              ：{diagnostic.message}
            </p>
          ))}
        </div>
      )}

      <div className="wc-paper-stack">
        {props.settings.servers.length === 0 && (
          <p className="rounded-lg border border-dashed border-neutral-300 px-3 py-4 text-center text-xs text-neutral-500">
            尚未配置 MCP 服务。可使用上方表单新增，或编辑全局/项目配置文件。
          </p>
        )}
        {props.settings.servers.map((server, index) => (
          <PaperFrame
            key={`${server.scope}:${server.name}`}
            className="wc-paper-frame-soft"
          >
            <div className={`${MCP_CARD_STYLES[index % MCP_CARD_STYLES.length]} wc-paper-pad min-w-0 [overflow-wrap:anywhere]`}>
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="min-w-0 break-all text-xs font-medium text-neutral-900">{server.name}</p>
                    <Badge text={scopeLabel(server.scope)} />
                    <Badge text={server.transport === 'http' ? 'Streamable HTTP' : 'stdio'} />
                    {server.builtinId && <Badge text="内置默认" />}
                    {!server.effective && <Badge text="被项目同名配置覆盖" warning />}
                  </div>
                  <p className="mt-1 wc-type-caption text-neutral-500">
                    {currentSessionLabel(
                      props.settings.currentSessionUsesSnapshot,
                      server.currentSessionState,
                      server.currentSessionToolCount,
                    )}
                  </p>
                </div>
                <label className="flex shrink-0 items-center gap-1.5 wc-type-caption text-neutral-600">
                  <input
                    type="checkbox"
                    checked={server.enabled}
                    onChange={(event) => void props.onSetEnabled({
                      scope: server.scope,
                      name: server.name,
                      enabled: event.target.checked,
                    })}
                    disabled={props.disabled}
                  />
                  {server.enabled ? '已启用' : '已关闭'}
                </label>
              </div>
              {server.currentSessionError && (
                <p className="mt-2 break-words wc-type-caption text-red-700">连接错误：{server.currentSessionError}</p>
              )}
              {server.currentSessionDiagnostics.map((diagnostic, index) => (
                <p key={index} className="mt-1 break-words wc-type-caption text-amber-700">目录诊断：{diagnostic}</p>
              ))}
              <McpSecretHeaderEditor
                server={server}
                disabled={props.disabled}
                onSave={props.onSaveSecretHeader}
              />
              <McpOAuthEditor
                server={server}
                disabled={props.disabled}
                onAuthorize={props.onAuthorizeOAuth}
                onDisconnect={props.onDisconnectOAuth}
              />
            </div>
          </PaperFrame>
        ))}
      </div>

      <p className="wc-type-caption text-neutral-500">
        当前会话不会热替换 MCP 服务器；新建会话后采用最新配置。项目配置首次使用时仍会要求显式信任。
      </p>
    </section>
  )
}

const MCP_CARD_STYLES = [
  'wc-paper-card wc-paper-blue wc-paper-shape-d wc-paper-angle-soft-left',
  'wc-paper-card wc-paper-sand wc-paper-shape-b wc-paper-angle-soft-right',
  'wc-paper-card wc-paper-sage wc-paper-shape-d wc-paper-angle-soft-left',
  'wc-paper-card wc-paper-rose wc-paper-shape-b wc-paper-angle-soft-right',
  'wc-paper-card wc-paper-blue wc-paper-shape-d wc-paper-angle-soft-left',
  'wc-paper-card wc-paper-sand wc-paper-shape-b wc-paper-angle-soft-right',
] as const

function Badge(props: { text: string; warning?: boolean }) {
  return (
    <span className={`rounded px-1.5 py-0.5 wc-type-tiny ${
      props.warning ? 'bg-amber-50 text-amber-700' : 'bg-neutral-100 text-neutral-600'
    }`}>
      {props.text}
    </span>
  )
}

function scopeLabel(scope: 'global' | 'project'): string {
  return scope === 'global' ? '全局' : '项目'
}

function currentSessionLabel(
  hasSessionSnapshot: boolean,
  state: McpSettingsItem['servers'][number]['currentSessionState'],
  toolCount = 0,
): string {
  if (!hasSessionSnapshot) return '尚未创建实际会话；将在首条消息时固化配置'
  if (!state) return '不在当前会话快照中；配置变更将在新会话生效'
  if (state === 'ready') return `当前会话已连接 · ${toolCount} 个工具`
  return {
    idle: '当前会话按需连接，尚未启动',
    connecting: '当前会话正在连接',
    refreshing: '当前会话正在刷新工具目录',
    failed: '当前会话连接失败',
    disconnected: '当前会话连接已关闭',
  }[state]
}
