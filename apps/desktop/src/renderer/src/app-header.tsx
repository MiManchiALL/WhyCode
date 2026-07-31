import { PERMISSION_MODES, type PermissionMode } from '@whycode/core/permissions'
import type {
  ReasoningEffort,
  ReasoningEffortSelection,
} from '@whycode/core'
import type { ModelListItem } from '../../shared/settings.ts'
import type { RuntimeWorkspace } from '../../shared/workspace.ts'

interface ConsensusStatus {
  ready: boolean
  reason: string | null
  enabled: boolean
}

interface AppHeaderProps {
  projectDir: string | null
  workspaceMode: RuntimeWorkspace['mode']
  busy: boolean
  sessionChangeLocked: boolean
  permissionLocked: boolean
  consensus: ConsensusStatus
  permMode: PermissionMode
  models: ModelListItem[]
  modelId: string
  reasoningEffort: ReasoningEffortSelection
  onPickProject: () => void
  onOpenWorkspaceDetails: () => void
  onToggleConsensus: () => void
  onCompact: () => void
  onPermissionChange: (mode: PermissionMode) => void
  onModelChange: (modelId: string) => void
  onReasoningEffortChange: (reasoningEffort: ReasoningEffortSelection) => void
  onOpenSessions: () => void
  onNewSession: () => void
  onOpenConnectionSettings: () => void
}

export function AppHeader(props: AppHeaderProps) {
  const selectedModel = props.models.find((model) => model.id === props.modelId)
  const retired = Boolean(selectedModel?.retired)
  const unavailable = Boolean(selectedModel && !selectedModel.available)
  const effort = retired || unavailable ? undefined : selectedModel?.reasoningEffort
  const selectedEffort = effort
    ? props.reasoningEffort === 'default'
      ? effort.default
      : effort.supported.includes(props.reasoningEffort)
        ? props.reasoningEffort
        : effort.default
    : 'default'
  return (
    <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">WhyCode</span>
        <button
          className="max-w-96 truncate rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:border-neutral-500"
          onClick={props.onPickProject}
          disabled={props.sessionChangeLocked}
          title={props.projectDir ? `当前工作文件夹：${props.projectDir}` : '正在准备默认工作文件夹'}
        >
          {props.projectDir ?? '📁 工作文件夹'}
        </button>
        {props.workspaceMode === 'worktree' ? (
          <button
            className="rounded bg-violet-100 px-2 py-1 text-[11px] font-medium text-violet-700 hover:bg-violet-200"
            onClick={props.onOpenWorkspaceDetails}
            title="查看 Worktree 状态、差异与交付操作"
          >
            Worktree
          </button>
        ) : props.workspaceMode === 'pending-worktree' ? (
          <span
            className="rounded bg-violet-100 px-2 py-1 text-[11px] font-medium text-violet-700"
            title="发送第一条消息时创建隔离 Worktree"
          >
            Worktree · 待创建
          </span>
        ) : props.workspaceMode === 'local' ? (
          <span
            className="rounded bg-neutral-100 px-2 py-1 text-[11px] text-neutral-500"
            title="当前会话直接使用本地工作文件夹"
          >
            本地
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <button
          className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-500 hover:border-neutral-500 disabled:opacity-40"
          onClick={props.onOpenSessions}
          disabled={props.sessionChangeLocked}
        >
          历史
        </button>
        <button
          className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-500 hover:border-neutral-500 disabled:opacity-40"
          onClick={props.onNewSession}
          disabled={props.sessionChangeLocked}
        >
          ＋ 新会话
        </button>
        <ConsensusButton {...props} />
        <button
          className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-500 hover:border-neutral-500 disabled:opacity-40"
          onClick={props.onCompact}
          disabled={props.busy}
          title="手动压缩上下文：把较早的对话浓缩为摘要，释放上下文空间"
        >
          🗜 压缩
        </button>
        <select
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs disabled:cursor-not-allowed disabled:border-neutral-200 disabled:bg-neutral-100 disabled:text-neutral-400"
          value={props.permMode}
          onChange={(event) => props.onPermissionChange(event.target.value as PermissionMode)}
          disabled={props.permissionLocked}
          title="权限档位：控制哪些操作需要审批"
        >
          {PERMISSION_MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>{mode.label}</option>
          ))}
        </select>
        <button
          className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-500 hover:border-neutral-500 disabled:opacity-40"
          onClick={props.onOpenConnectionSettings}
          disabled={props.busy}
          title="配置模型、网页搜索与 MCP 连接"
        >
          ⚙ 连接
        </button>
        <select
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs disabled:cursor-not-allowed disabled:border-neutral-200 disabled:bg-neutral-100 disabled:text-neutral-400"
          value={selectedEffort}
          onChange={(event) =>
            props.onReasoningEffortChange(event.target.value as ReasoningEffortSelection)}
          disabled={props.busy || !effort}
          title={effort ? '当前会话的推理强度' : '当前模型没有官方可选的推理强度档位'}
        >
          {effort
            ? effort.supported.map((level) => (
                <option key={level} value={level}>推理：{reasoningEffortLabel(level)}</option>
              ))
            : <option value="default">推理：默认</option>}
        </select>
        <select
          className={`rounded border bg-white px-2 py-1 text-xs ${
            retired
              ? 'border-red-300 text-red-600'
              : unavailable
                ? 'border-amber-300 text-amber-700'
                : 'border-neutral-300'
          }`}
          value={retired || unavailable ? '' : props.modelId}
          onChange={(event) => {
            if (event.target.value) props.onModelChange(event.target.value)
          }}
          disabled={props.busy}
        >
          {(!selectedModel || retired || unavailable) && (
            <option value="" disabled hidden>
              {retired
                ? `${selectedModel?.displayName ?? props.modelId}（已停止支持）`
                : unavailable
                  ? `${selectedModel?.displayName ?? props.modelId}（当前未配置）`
                  : '请选择模型'}
            </option>
          )}
          {props.models.filter((model) => model.available && !model.retired).map((model) => (
            <option className="text-neutral-900" key={model.id} value={model.id}>
              {model.displayName}{model.supportsImageInput ? ' · 图片' : ''}
            </option>
          ))}
        </select>
      </div>
    </header>
  )
}

function reasoningEffortLabel(level: ReasoningEffort): string {
  return {
    none: '关闭',
    minimal: '最少',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最高',
  }[level]
}

function ConsensusButton(props: AppHeaderProps) {
  const enabled = props.consensus.enabled
  return (
    <button
      className={`rounded border px-2 py-1 text-xs disabled:opacity-40 ${
        enabled
          ? 'border-violet-400 bg-violet-50 text-violet-700'
          : 'border-neutral-300 text-neutral-500 hover:border-neutral-500'
      }`}
      onClick={props.onToggleConsensus}
      disabled={props.busy || (!enabled && !props.consensus.ready)}
      title={
        enabled
          ? '多 Agent 协商已开启：Main 提案，B/C 独立评审'
          : props.consensus.reason ?? '开启多 Agent 协商：Main 提案，B/C 独立评审后再执行'
      }
    >
      🤝 协商{enabled ? '·开' : ''}
    </button>
  )
}
