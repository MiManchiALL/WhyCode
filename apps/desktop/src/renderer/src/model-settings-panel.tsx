import { useState } from 'react'
import type { ReasoningEffort, ReasoningEffortCapability } from '@whycode/core'
import type {
  CliProxyApiSettingsItem,
  ModelSettingsSnapshot,
  ProviderSettingsItem,
  SaveCliProxyApiSettingsRequest,
  SaveProviderSettingsRequest,
  SettingsMutationResult,
} from '../../shared/settings.ts'
import { WebSearchSettingsEditor } from './web-search-settings.tsx'

interface ModelSettingsPanelProps {
  snapshot: ModelSettingsSnapshot
  onClose: () => void
  onChanged: (snapshot: ModelSettingsSnapshot) => void
}

export function ModelSettingsPanel(props: ModelSettingsPanelProps) {
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
            <h2 className="text-base font-semibold">模型与搜索设置</h2>
            <p className="mt-0.5 text-xs text-neutral-500">配置内置厂商、CLIProxyAPI 与网页搜索服务。</p>
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

          <CliProxyApiEditor
            settings={props.snapshot.cliProxyApi}
            disabled={pending}
            onSave={(request) => mutate(() => window.whycode.saveCliProxyApiSettings(request))}
          />

          <WebSearchSettingsEditor
            settings={props.snapshot.webSearch}
            disabled={pending}
            onSave={(request) => mutate(() => window.whycode.saveWebSearchSettings(request))}
          />
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
        <ConnectionStatus configured={props.provider.hasKey} />
      </div>
      <div className="mb-2 space-y-0.5">
        {props.provider.models.map((model) => (
          <p key={model.id} className="text-[11px] text-neutral-500">
            {model.displayName}
            {' · '}{model.capabilities.supportsImageInput ? '图片' : '仅文本'}
            {' · '}{formatTokenLimit(model.capabilities.contextWindow)} 上下文
            {' · '}{formatTokenLimit(model.capabilities.maxOutput)} 输出
            {' · '}{model.capabilities.reasoningExposure === 'none' ? '无推理透传' : '推理'}
          </p>
        ))}
      </div>
      <label className="block text-[11px] text-neutral-600">API Key（留空保留现有密钥）</label>
      <input className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-xs" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={props.disabled} autoComplete="new-password" />
      <label className="mt-2 block text-[11px] text-neutral-600">Base URL（留空使用官方端点；也可填写保持该厂商协议的中转地址）</label>
      <input className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-xs" value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder={props.provider.defaultBaseURL} disabled={props.disabled} />
      <div className="mt-2 flex items-center gap-2">
        <button className="rounded bg-neutral-900 px-2 py-1 text-xs text-white disabled:opacity-40" onClick={() => void submit()} disabled={props.disabled}>保存</button>
        {props.provider.hasKey && <button className="text-xs text-red-600 disabled:opacity-40" onClick={() => void submit(true)} disabled={props.disabled}>清除密钥</button>}
        {saved && <span className="text-[11px] text-green-700">已保存</span>}
      </div>
    </div>
  )
}

function CliProxyApiEditor(props: {
  settings: CliProxyApiSettingsItem
  disabled: boolean
  onSave: (request: SaveCliProxyApiSettingsRequest) => Promise<boolean>
}) {
  const [apiKey, setApiKey] = useState('')
  const [baseURL, setBaseURL] = useState(props.settings.baseURL ?? '')
  const [modelIds, setModelIds] = useState(() => new Set(
    props.settings.models.filter((model) => model.enabled).map((model) => model.id),
  ))
  const [saved, setSaved] = useState(false)
  const toggleModel = (modelId: string) => {
    setModelIds((current) => {
      const next = new Set(current)
      if (next.has(modelId)) next.delete(modelId)
      else next.add(modelId)
      return next
    })
  }
  const submit = async (clearApiKey = false) => {
    setSaved(false)
    const ok = await props.onSave({
      baseURL,
      apiKey,
      clearApiKey,
      modelIds: props.settings.models
        .filter((model) => modelIds.has(model.id))
        .map((model) => model.id),
    })
    if (ok) { setApiKey(''); setSaved(true) }
  }

  return (
    <section>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">CLIProxyAPI</h3>
          <p className="text-xs text-neutral-500">只开放已确认与 WhyCode 型号等价的 CLIProxyAPI 路由；启用后以“（CLIProxyAPI）”区分连接来源。</p>
        </div>
        <ConnectionStatus configured={props.settings.hasKey} />
      </div>
      <div className="rounded-lg border border-neutral-200 p-3">
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-[11px] text-neutral-600">
            Base URL
            <input className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-xs" value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder="http://127.0.0.1:8317/v1" disabled={props.disabled} />
          </label>
          <label className="block text-[11px] text-neutral-600">
            API Key（留空保留现有密钥）
            <input className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-xs" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={props.disabled} autoComplete="new-password" />
          </label>
        </div>
        <p className="mt-3 text-[11px] font-medium text-neutral-600">启用模型</p>
        <div className="mt-1 grid gap-1.5 md:grid-cols-2">
          {props.settings.models.map((model) => (
            <label key={model.id} className="flex items-start gap-2 rounded border border-neutral-200 px-2 py-1.5 text-xs">
              <input type="checkbox" className="mt-0.5" checked={modelIds.has(model.id)} onChange={() => toggleModel(model.id)} disabled={props.disabled} />
              <span>
                <span className="block text-neutral-800">{model.displayName}</span>
                <span className="block text-[10px] text-neutral-500">
                  {model.capabilities.supportsImageInput ? '图片' : '仅文本'}
                  {' · '}{formatTokenLimit(model.capabilities.contextWindow)} 上下文
                  {' · '}{formatTokenLimit(model.capabilities.maxOutput)} 输出
                  {' · '}{reasoningEffortSummary(model.capabilities.reasoningEffort)}
                </span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-neutral-500">推理强度在顶部随当前会话选择；WhyCode 会按所选型号限制档位，并通过对应协议传给 CLIProxyAPI。</p>
        <div className="mt-3 flex items-center gap-2">
          <button className="rounded bg-neutral-900 px-3 py-1 text-xs text-white disabled:opacity-40" onClick={() => void submit()} disabled={props.disabled}>保存</button>
          {props.settings.hasKey && <button className="text-xs text-red-600 disabled:opacity-40" onClick={() => void submit(true)} disabled={props.disabled}>清除密钥</button>}
          {saved && <span className="text-[11px] text-green-700">已保存</span>}
        </div>
      </div>
    </section>
  )
}

function ConnectionStatus(props: { configured: boolean }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] ${props.configured ? 'bg-green-50 text-green-700' : 'bg-neutral-100 text-neutral-500'}`}>
      {props.configured ? '已配置' : '未配置'}
    </span>
  )
}

function reasoningEffortSummary(effort?: ReasoningEffortCapability): string {
  if (!effort) return '推理：默认（无官方可选档位）'
  const levels = effort.supported.map(reasoningEffortLabel).join(' / ')
  return `推理：${levels}；默认 ${reasoningEffortLabel(effort.default)}`
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

function formatTokenLimit(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`
  return `${Number((tokens / 1_000).toFixed(1))}K`
}
