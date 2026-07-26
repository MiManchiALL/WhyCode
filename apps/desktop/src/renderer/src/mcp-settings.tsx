import type {
  EnableMcpPresetRequest,
  McpSettingsItem,
  OpenMcpConfigRequest,
  SetMcpServerEnabledRequest,
} from '../../shared/settings.ts'

interface McpSettingsEditorProps {
  settings: McpSettingsItem
  disabled: boolean
  onSetEnabled: (request: SetMcpServerEnabledRequest) => Promise<boolean>
  onEnablePreset: (request: EnableMcpPresetRequest) => Promise<boolean>
  onOpenConfig: (request: OpenMcpConfigRequest) => Promise<void>
  onRefresh: () => Promise<void>
}

export function McpSettingsEditor(props: McpSettingsEditorProps) {
  const context7 = props.settings.recommendedPresets.find((preset) =>
    preset.id === 'context7')
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">MCP 服务</h3>
          <p className="text-xs text-neutral-500">
            外部工具按需连接并通过 ToolSearch 延迟加载；启停写入原 MCP 配置，新会话生效。
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            className="rounded border border-neutral-300 px-2 py-1 text-[11px] text-neutral-600 disabled:opacity-40"
            onClick={() => void props.onRefresh()}
            disabled={props.disabled}
          >
            刷新状态
          </button>
          <button
            className="rounded border border-neutral-300 px-2 py-1 text-[11px] text-neutral-600 disabled:opacity-40"
            onClick={() => void props.onOpenConfig({ scope: 'global' })}
            disabled={props.disabled}
            title={props.settings.globalConfigPath}
          >
            打开全局配置
          </button>
          {props.settings.projectConfigPath && (
            <button
              className="rounded border border-neutral-300 px-2 py-1 text-[11px] text-neutral-600 disabled:opacity-40"
              onClick={() => void props.onOpenConfig({ scope: 'project' })}
              disabled={props.disabled}
              title={props.settings.projectConfigPath}
            >
              打开项目配置
            </button>
          )}
        </div>
      </div>

      {context7 && (
        <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50/50 p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-emerald-900">推荐预设 · {context7.displayName}</p>
              <p className="mt-1 text-[11px] text-emerald-800">{context7.description}</p>
            </div>
            {context7.status === 'available' ? (
              <button
                className="shrink-0 rounded bg-emerald-700 px-2 py-1 text-[11px] text-white disabled:opacity-40"
                onClick={() => void props.onEnablePreset({ presetId: context7.id })}
                disabled={props.disabled}
              >
                启用
              </button>
            ) : (
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                context7.status === 'installed'
                  ? 'bg-emerald-100 text-emerald-800'
                  : 'bg-amber-100 text-amber-800'
              }`}>
                {context7.status === 'installed' ? '已加入配置' : '同名配置已占用'}
              </span>
            )}
          </div>
        </div>
      )}

      {props.settings.diagnostics.length > 0 && (
        <div className="mb-3 space-y-1 rounded-lg border border-red-200 bg-red-50 p-3">
          {props.settings.diagnostics.map((diagnostic, index) => (
            <p key={`${diagnostic.scope}:${diagnostic.server ?? ''}:${index}`} className="text-[11px] text-red-700">
              {scopeLabel(diagnostic.scope)}
              {diagnostic.server ? ` · ${diagnostic.server}` : ''}
              ：{diagnostic.message}
            </p>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {props.settings.servers.length === 0 && (
          <p className="rounded-lg border border-dashed border-neutral-300 px-3 py-4 text-center text-xs text-neutral-500">
            尚未配置 MCP 服务。可启用上方推荐预设，或编辑全局/项目配置文件。
          </p>
        )}
        {props.settings.servers.map((server) => (
          <div key={`${server.scope}:${server.name}`} className="rounded-lg border border-neutral-200 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="truncate text-xs font-medium text-neutral-900">{server.name}</p>
                  <Badge text={scopeLabel(server.scope)} />
                  <Badge text={server.transport === 'http' ? 'Streamable HTTP' : 'stdio'} />
                  {!server.effective && <Badge text="被项目同名配置覆盖" warning />}
                </div>
                <p className="mt-1 text-[11px] text-neutral-500">
                  {currentSessionLabel(
                    props.settings.currentSessionUsesSnapshot,
                    server.currentSessionState,
                    server.currentSessionToolCount,
                  )}
                </p>
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-neutral-600">
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
              <p className="mt-2 text-[11px] text-red-700">连接错误：{server.currentSessionError}</p>
            )}
            {server.currentSessionDiagnostics.map((diagnostic, index) => (
              <p key={index} className="mt-1 text-[11px] text-amber-700">目录诊断：{diagnostic}</p>
            ))}
          </div>
        ))}
      </div>

      <p className="mt-2 text-[11px] text-neutral-500">
        当前会话不会热替换 MCP 服务器；新建会话后采用最新配置。项目配置首次使用时仍会要求显式信任。
      </p>
    </section>
  )
}

function Badge(props: { text: string; warning?: boolean }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] ${
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
