import { useState } from 'react'
import type {
  SaveWebSearchSettingsRequest,
  WebSearchProviderId,
  WebSearchSettingsItem,
} from '../../shared/settings.ts'

interface WebSearchSettingsProps {
  settings: WebSearchSettingsItem
  disabled: boolean
  onSave: (request: SaveWebSearchSettingsRequest) => Promise<boolean>
}

type SearchProvider = WebSearchSettingsItem['providers'][number]

export function WebSearchSettingsEditor(props: WebSearchSettingsProps) {
  const configured = props.settings.providers.some((provider) => provider.hasKey)
  const activate = (provider: WebSearchProviderId) => props.onSave({
    provider,
    setActive: true,
  })

  return (
    <section>
      <div className="mb-2 flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">网页搜索</h3>
          <p className="text-xs text-neutral-500">
            Agent 始终使用统一 WebSearch 工具；这里选择实际提供搜索结果的后端。
          </p>
        </div>
        <label className="text-[11px] text-neutral-600">
          当前后端
          <select
            className="ml-2 rounded border border-neutral-300 px-2 py-1 text-xs"
            value={props.settings.activeProvider}
            onChange={(event) => void activate(event.target.value as WebSearchProviderId)}
            disabled={props.disabled || !configured}
          >
            {props.settings.providers.map((provider) => (
              <option key={provider.id} value={provider.id} disabled={!provider.hasKey}>
                {provider.displayName}{provider.hasKey ? '' : '（未配置）'}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {props.settings.providers.map((provider) => (
          <SearchProviderEditor
            key={provider.id}
            provider={provider}
            active={provider.id === props.settings.activeProvider}
            disabled={props.disabled}
            onSave={props.onSave}
          />
        ))}
      </div>
    </section>
  )
}

function SearchProviderEditor(props: {
  provider: SearchProvider
  active: boolean
  disabled: boolean
  onSave: (request: SaveWebSearchSettingsRequest) => Promise<boolean>
}) {
  const [apiKey, setApiKey] = useState('')
  const [saved, setSaved] = useState(false)
  const submit = async (clearApiKey = false) => {
    setSaved(false)
    const ok = await props.onSave({
      provider: props.provider.id,
      apiKey,
      clearApiKey,
    })
    if (ok) {
      setApiKey('')
      setSaved(true)
    }
  }

  return (
    <div className="rounded-lg border border-neutral-200 p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{props.provider.displayName}</p>
          <p className="text-[11px] text-neutral-500">
            {providerDescription(props.provider.id)}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {props.active && props.provider.hasKey && (
            <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700">
              当前
            </span>
          )}
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${props.provider.hasKey ? 'bg-green-50 text-green-700' : 'bg-neutral-100 text-neutral-500'}`}>
            {props.provider.hasKey ? '已配置' : '未配置'}
          </span>
        </div>
      </div>
      <label className="block text-[11px] text-neutral-600">
        API Key（留空保留现有密钥）
      </label>
      <input
        className="mt-1 w-full rounded border border-neutral-300 px-2 py-1 text-xs"
        type="password"
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        disabled={props.disabled}
        autoComplete="new-password"
        placeholder={props.provider.id === 'tavily' ? 'tvly-…' : 'pplx-…'}
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          className="rounded bg-neutral-900 px-2 py-1 text-xs text-white disabled:opacity-40"
          onClick={() => void submit()}
          disabled={props.disabled}
        >
          保存
        </button>
        {props.provider.hasKey && (
          <button
            className="text-xs text-red-600 disabled:opacity-40"
            onClick={() => void submit(true)}
            disabled={props.disabled}
          >
            清除密钥
          </button>
        )}
        {saved && <span className="text-[11px] text-green-700">已保存</span>}
      </div>
    </div>
  )
}

function providerDescription(provider: WebSearchProviderId): string {
  if (provider === 'tavily') {
    return '固定 basic 搜索；批量查询会并发请求，密钥只在主进程解密使用。'
  }
  return '固定 low 搜索上下文；密钥只在主进程解密使用。'
}
