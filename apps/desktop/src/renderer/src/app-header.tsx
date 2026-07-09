import { PERMISSION_MODES, type PermissionMode } from '@whycode/core/permissions'

interface ModelOption {
  id: string
  displayName: string
  hasKey: boolean
}

interface ConsensusStatus {
  ready: boolean
  reason: string | null
  enabled: boolean
}

interface AppHeaderProps {
  projectDir: string | null
  busy: boolean
  consensus: ConsensusStatus
  permMode: PermissionMode
  models: ModelOption[]
  modelId: string
  onPickProject: () => void
  onToggleConsensus: () => void
  onCompact: () => void
  onPermissionChange: (mode: PermissionMode) => void
  onModelChange: (modelId: string) => void
  onOpenSessions: () => void
  onNewSession: () => void
}

export function AppHeader(props: AppHeaderProps) {
  return (
    <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-2">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">WhyCode</span>
        <button
          className="max-w-96 truncate rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:border-neutral-500"
          onClick={props.onPickProject}
          disabled={props.busy}
          title={props.projectDir ?? '选择要工作的项目目录'}
        >
          {props.projectDir ?? '📁 选择项目目录'}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <button
          className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-500 hover:border-neutral-500 disabled:opacity-40"
          onClick={props.onOpenSessions}
          disabled={props.busy}
        >
          历史
        </button>
        <button
          className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-500 hover:border-neutral-500 disabled:opacity-40"
          onClick={props.onNewSession}
          disabled={props.busy}
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
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
          value={props.permMode}
          onChange={(event) => props.onPermissionChange(event.target.value as PermissionMode)}
          title="权限档位：控制哪些操作需要审批"
        >
          {PERMISSION_MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>{mode.label}</option>
          ))}
        </select>
        <select
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
          value={props.modelId}
          onChange={(event) => props.onModelChange(event.target.value)}
          disabled={props.busy}
        >
          {props.models.map((model) => (
            <option key={model.id} value={model.id} disabled={!model.hasKey}>
              {model.displayName}{model.hasKey ? '' : '（未配置 key）'}
            </option>
          ))}
        </select>
      </div>
    </header>
  )
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
