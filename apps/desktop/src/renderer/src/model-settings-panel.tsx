import { useMemo, useState, type ReactElement } from 'react'
import type {
  CustomConnectionSettingsItem,
  ModelSettingsSnapshot,
  ProviderSettingsItem,
  SaveCustomConnectionRequest,
  SaveProviderSettingsRequest,
  SettingsMutationResult,
} from '../../shared/settings.ts'

interface ModelSettingsPanelProps {
  snapshot: ModelSettingsSnapshot
  onClose: () => void
  onChanged: (snapshot: ModelSettingsSnapshot) => void
}

export function ModelSettingsPanel(props: ModelSettingsPanelProps) {
  const [editing, setEditing] = useState<CustomConnectionSettingsItem | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const mutate = async (operation: () => Promise<SettingsMutationResult>) => {
    setPending(true)
    setError(null)
    try {
      const result = await operation()
      if (!result.ok || !result.snapshot) {
        setError(result.error ?? '设置保存失败')
        return false
      }
      props.onChanged(result.snapshot)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-6">
      <section className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
          <div>
            <h2 className="text-base font-semibold">模型设置</h2>
            <p className="mt-0.5 text-xs text-neutral-500">官方模型只需 API key；自定义端点需检测实际传输能力。</p>
          </div>
          <button className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100" onClick={props.onClose} disabled={pending}>关闭</button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

          <section>
            <h3 className="mb-2 text-sm font-medium">内置厂商</h3>
            <div className="grid gap-3 lg:grid-cols-2">
              {props.snapshot.providers.map((provider) => (
                <ProviderEditor
                  key={provider.id}
                  provider={provider}
                  disabled={pending}
                  onSave={(request) => mutate(() => window.whycode.saveProviderSettings(request))}
                />
              ))}
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium">自定义连接</h3>
                <p className="text-xs text-neutral-500">严格匹配已维护型号后继承上下文、输出和 thinking 信息；未知型号采用保守默认。</p>
              </div>
              <button
                className="rounded border border-neutral-300 px-2 py-1 text-xs hover:border-neutral-500 disabled:opacity-40"
                onClick={() => { setEditing(null); setAdding(true); setError(null) }}
                disabled={pending || adding}
              >
                ＋ 添加连接
              </button>
            </div>

            <div className="space-y-2">
              {props.snapshot.customConnections.length === 0 && !adding && (
                <p className="rounded border border-dashed border-neutral-300 p-4 text-center text-xs text-neutral-400">还没有自定义连接</p>
              )}
              {props.snapshot.customConnections.map((connection) => (
                <CustomConnectionRow
                  key={connection.id}
                  connection={connection}
                  disabled={pending}
                  onEdit={() => { setEditing(connection); setAdding(false); setError(null) }}
                  onDelete={() => {
                    if (!window.confirm(`删除自定义连接“${connection.name}”？`)) return
                    void mutate(() => window.whycode.deleteCustomConnection(connection.id))
                  }}
                />
              ))}
            </div>

            {(adding || editing) && (
              <CustomConnectionEditor
                key={editing?.id ?? 'new'}
                connection={editing}
                snapshot={props.snapshot}
                disabled={pending}
                onCancel={() => { setAdding(false); setEditing(null) }}
                onSave={async (request) => {
                  const saved = await mutate(() => window.whycode.saveCustomConnection(request))
                  if (saved) { setAdding(false); setEditing(null) }
                }}
              />
            )}
          </section>
        </div>
      </section>
    </div>
  )
}

function ProviderEditor(props: {
  provider: ProviderSettingsItem
  disabled: boolean
  onSave: (request: SaveProviderSettingsRequest) => Promise<boolean>
}) {
  const [apiKey, setApiKey] = useState('')
  const [baseURL, setBaseURL] = useState(props.provider.baseURL ?? '')
  const [saved, setSaved] = useState(false)
  const submit = async (clearApiKey = false) => {
    setSaved(false)
    const ok = await props.onSave({
      providerId: props.provider.id,
      apiKey,
      clearApiKey,
      baseURL,
    })
    if (ok) { setApiKey(''); setSaved(true) }
  }
  return (
    <div className="rounded-lg border border-neutral-200 p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{props.provider.displayName}</p>
          <p className="text-[11px] text-neutral-500">{props.provider.protocolLabel}</p>
        </div>
        <span className={`rounded px-1.5 py-0.5 text-[10px] ${props.provider.hasKey ? 'bg-green-50 text-green-700' : 'bg-neutral-100 text-neutral-500'}`}>
          {props.provider.hasKey ? '已配置' : '未配置'}
        </span>
      </div>
      <div className="mb-2 space-y-0.5">
        {props.provider.models.map((model) => (
          <p key={model.id} className="text-[11px] text-neutral-500">
            {model.displayName}
            {' · '}{model.capabilities.supportsImageInput ? '图片' : '仅文本'}
            {' · '}{formatTokenLimit(model.capabilities.contextWindow)} 上下文
            {' · '}{formatTokenLimit(model.capabilities.maxOutput)} 输出
            {' · '}{model.capabilities.reasoningExposure === 'none' ? '无思考透传' : '思考'}
          </p>
        ))}
      </div>
      <label className="block text-[11px] text-neutral-600">API Key（留空保留现有密钥）</label>
      <input className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-xs" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={props.disabled} autoComplete="new-password" />
      <label className="mt-2 block text-[11px] text-neutral-600">Base URL（可缺省；兼容代理/旧配置，覆写后默认关闭图片能力）</label>
      <input className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-xs" value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder={props.provider.defaultBaseURL} disabled={props.disabled} />
      <div className="mt-2 flex items-center gap-2">
        <button className="rounded bg-neutral-900 px-2 py-1 text-xs text-white disabled:opacity-40" onClick={() => void submit()} disabled={props.disabled}>保存</button>
        {props.provider.hasKey && <button className="text-xs text-red-600 disabled:opacity-40" onClick={() => void submit(true)} disabled={props.disabled}>清除密钥</button>}
        {saved && <span className="text-[11px] text-green-700">已保存</span>}
      </div>
    </div>
  )
}

function CustomConnectionRow(props: {
  connection: CustomConnectionSettingsItem
  disabled: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const fullAgent = props.connection.probe.text === 'supported' && props.connection.probe.tools === 'supported'
  return (
    <div className="flex items-center justify-between gap-3 rounded border border-neutral-200 px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{props.connection.name}</span>
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${fullAgent ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>{fullAgent ? 'Agent 可用' : '工具未通过'}</span>
        </div>
        <p className="truncate text-[11px] text-neutral-500">{props.connection.modelId} · {props.connection.baseURL}</p>
        <p className="text-[11px] text-neutral-500">{props.connection.matchedProfile ? `已匹配 ${props.connection.matchedProfile.displayName}` : '未知型号：使用保守能力默认值'}</p>
        <div className="mt-1 flex flex-wrap gap-1">
          <ProbeStatus label="文本" state={props.connection.probe.text} detail={props.connection.probeDetails?.text} />
          <ProbeStatus label="工具" state={props.connection.probe.tools} detail={props.connection.probeDetails?.tools} />
          <ProbeStatus label="图片" state={props.connection.probe.image} detail={props.connection.probeDetails?.image} />
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <button className="text-xs text-neutral-600 disabled:opacity-40" onClick={props.onEdit} disabled={props.disabled}>编辑/重测</button>
        <button className="text-xs text-red-600 disabled:opacity-40" onClick={props.onDelete} disabled={props.disabled}>删除</button>
      </div>
    </div>
  )
}

function ProbeStatus(props: {
  label: string
  state: CustomConnectionSettingsItem['probe']['text']
  detail?: string
}) {
  const styles = props.state === 'supported'
    ? 'bg-green-50 text-green-700'
    : props.state === 'unsupported'
      ? 'bg-red-50 text-red-700'
      : 'bg-amber-50 text-amber-700'
  const stateLabel = props.state === 'supported'
    ? '通过'
    : props.state === 'unsupported' ? '不支持' : '未确认'
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] ${styles}`} title={props.detail}>
      {props.label}：{stateLabel}
    </span>
  )
}

function formatTokenLimit(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`
  return `${Number((tokens / 1_000).toFixed(1))}K`
}

function CustomConnectionEditor(props: {
  connection: CustomConnectionSettingsItem | null
  snapshot: ModelSettingsSnapshot
  disabled: boolean
  onCancel: () => void
  onSave: (request: SaveCustomConnectionRequest) => Promise<void>
}) {
  const firstProtocol = props.snapshot.protocols[0]!
  const [name, setName] = useState(props.connection?.name ?? '')
  const [protocol, setProtocol] = useState(props.connection?.protocol ?? firstProtocol.id)
  const [baseURL, setBaseURL] = useState(props.connection?.baseURL ?? '')
  const [apiKey, setApiKey] = useState('')
  const [modelId, setModelId] = useState(props.connection?.modelId ?? '')
  const hint = useMemo(
    () => props.snapshot.protocols.find((item) => item.id === protocol)?.hint,
    [props.snapshot.protocols, protocol],
  )
  return (
    <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50/30 p-3">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="连接名称"><input value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="API 协议">
          <select value={protocol} onChange={(event) => setProtocol(event.target.value as typeof protocol)}>
            {props.snapshot.protocols.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </Field>
        <Field label="Base URL"><input value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder="https://example.com/v1" /></Field>
        <Field label="API Key（编辑时留空保留）"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" /></Field>
        <Field label="模型 ID（手动输入）"><input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="例如 claude_sonnet-4.6 或 MiMo / V2_5" /></Field>
      </div>
      <p className="mt-2 text-[11px] text-neutral-500">{hint}</p>
      <p className="mt-1 text-[11px] text-neutral-500">保存前会发送独立的文本、无副作用工具和合成图片挑战，不会使用你的聊天或项目数据。</p>
      <div className="mt-3 flex gap-2">
        <button className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-40" disabled={props.disabled} onClick={() => void props.onSave({ id: props.connection?.id, name, protocol, baseURL, apiKey, modelId })}>{props.disabled ? '检测中…' : '检测并保存'}</button>
        <button className="rounded border border-neutral-300 bg-white px-3 py-1 text-xs disabled:opacity-40" disabled={props.disabled} onClick={props.onCancel}>取消</button>
      </div>
    </div>
  )
}

function Field(props: { label: string; children: ReactElement }) {
  return (
    <label className="block text-[11px] text-neutral-600">
      {props.label}
      <span className="mt-1 block [&>input]:w-full [&>input]:rounded [&>input]:border [&>input]:border-neutral-300 [&>input]:bg-white [&>input]:px-2 [&>input]:py-1 [&>input]:text-xs [&>select]:w-full [&>select]:rounded [&>select]:border [&>select]:border-neutral-300 [&>select]:bg-white [&>select]:px-2 [&>select]:py-1 [&>select]:text-xs">{props.children}</span>
    </label>
  )
}
