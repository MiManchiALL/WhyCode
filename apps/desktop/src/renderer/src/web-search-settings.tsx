import { useState } from 'react'
import type {
  SaveWebSearchSettingsRequest,
  WebSearchSettingsItem,
} from '../../shared/settings.ts'

interface WebSearchSettingsProps {
  settings: WebSearchSettingsItem
  disabled: boolean
  onSave: (request: SaveWebSearchSettingsRequest) => Promise<boolean>
}

export function WebSearchSettingsEditor(props: WebSearchSettingsProps) {
  const [apiKey, setApiKey] = useState('')
  const [saved, setSaved] = useState(false)
  const submit = async (clearApiKey = false) => {
    setSaved(false)
    const ok = await props.onSave({
      provider: props.settings.provider,
      apiKey,
      clearApiKey,
    })
    if (ok) {
      setApiKey('')
      setSaved(true)
    }
  }

  return (
    <section>
      <div className="mb-2">
        <h3 className="text-sm font-medium">网页搜索</h3>
        <p className="text-xs text-neutral-500">
          Agent 通过统一 WebSearch 工具查询；当前后端为 Perplexity Search API。
        </p>
      </div>
      <div className="rounded-lg border border-neutral-200 p-3">
        <div className="mb-2 flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-medium">{props.settings.displayName}</p>
            <p className="text-[11px] text-neutral-500">
              密钥只在主进程解密使用；首次搜索会明确提示搜索词将发送给外部服务。
            </p>
          </div>
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${props.settings.hasKey ? 'bg-green-50 text-green-700' : 'bg-neutral-100 text-neutral-500'}`}>
            {props.settings.hasKey ? '已配置' : '未配置'}
          </span>
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
          placeholder="pplx-…"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            className="rounded bg-neutral-900 px-2 py-1 text-xs text-white disabled:opacity-40"
            onClick={() => void submit()}
            disabled={props.disabled}
          >
            保存
          </button>
          {props.settings.hasKey && (
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
    </section>
  )
}
