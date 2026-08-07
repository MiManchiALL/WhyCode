import { useState } from 'react'
import type {
  SaveWebSearchSettingsRequest,
  TavilySearchDepth,
  WebSearchProviderId,
  WebSearchSettingsItem,
} from '../../shared/settings.ts'
import { PaperFrame } from './paper-frame.tsx'
import { SelectMenu } from './select-menu.tsx'

interface WebSearchSettingsProps {
  settings: WebSearchSettingsItem
  disabled: boolean
  onSave: (request: SaveWebSearchSettingsRequest) => Promise<boolean>
}

type SearchProvider = WebSearchSettingsItem['providers'][number]
const TAVILY_DEPTH_OPTIONS = [
  { value: 'basic', label: '标准（basic，1 credit，默认）' },
  { value: 'advanced', label: '高质量（advanced，2 credits）' },
] as const satisfies readonly { value: TavilySearchDepth; label: string }[]

export function WebSearchSettingsEditor(props: WebSearchSettingsProps) {
  const configured = props.settings.providers.some((provider) => provider.hasKey)
  const activate = (provider: WebSearchProviderId) => props.onSave({
    provider,
    setActive: true,
  })

  return (
    <section className="wc-paper-section">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">网页搜索</h3>
          <p className="text-xs text-neutral-500">
            Agent 始终使用统一 WebSearch 工具；这里选择实际提供搜索结果的后端。
          </p>
        </div>
        <div className="min-w-44 text-[11px] text-neutral-600">
          <span className="mb-1 block">当前后端</span>
          <SelectMenu
            value={props.settings.activeProvider}
            options={props.settings.providers.map((provider) => ({
              value: provider.id,
              label: `${provider.displayName}${provider.hasKey ? '' : '（未配置）'}`,
              disabled: !provider.hasKey,
            }))}
            onValueChange={(value) => void activate(value as WebSearchProviderId)}
            ariaLabel="网页搜索当前后端"
            disabled={props.disabled || !configured}
            className="w-full"
            align="end"
          />
        </div>
      </div>
      <div className="wc-paper-grid grid lg:grid-cols-2">
        {props.settings.providers.map((provider, index) => (
          <SearchProviderEditor
            key={provider.id}
            provider={provider}
            visualIndex={index}
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
  visualIndex: number
  active: boolean
  disabled: boolean
  onSave: (request: SaveWebSearchSettingsRequest) => Promise<boolean>
}) {
  const [apiKey, setApiKey] = useState('')
  const [searchDepth, setSearchDepth] = useState<TavilySearchDepth>(
    props.provider.searchDepth ?? 'basic',
  )
  const [saved, setSaved] = useState(false)
  const submit = async (clearApiKey = false) => {
    setSaved(false)
    const ok = await props.onSave({
      provider: props.provider.id,
      apiKey,
      clearApiKey,
      ...(props.provider.id === 'tavily' ? { searchDepth } : {}),
    })
    if (ok) {
      setApiKey('')
      setSaved(true)
    }
  }

  return (
    <PaperFrame>
      <div className={`${SEARCH_CARD_STYLES[props.visualIndex % SEARCH_CARD_STYLES.length]} wc-paper-pad`}>
        <div className="mb-2 flex items-start justify-between gap-2">
          <div>
            <p className="text-sm font-medium">{props.provider.displayName}</p>
            <p className="text-[11px] text-neutral-500">
              {providerDescription(props.provider.id)}
            </p>
          </div>
          <div className="flex items-center gap-1">
            {props.active && props.provider.hasKey && (
              <span className="rounded-lg bg-[var(--wc-blue)] px-1.5 py-0.5 text-[10px] text-[var(--wc-blue-ink)]">
                当前
              </span>
            )}
            <span className={`rounded-lg px-1.5 py-0.5 text-[10px] ${props.provider.hasKey ? 'bg-[var(--wc-sage)] text-[var(--wc-sage-ink)]' : 'bg-black/[0.045] text-[var(--wc-muted)]'}`}>
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
        {props.provider.id === 'tavily' && (
          <div className="mt-2 text-[11px] text-neutral-600">
            <span className="mb-1 block">搜索质量</span>
            <SelectMenu
              value={searchDepth}
              options={TAVILY_DEPTH_OPTIONS}
              onValueChange={(value) => setSearchDepth(value as TavilySearchDepth)}
              ariaLabel="Tavily 搜索质量"
              disabled={props.disabled}
              className="w-full"
            />
          </div>
        )}
        <div className="mt-2 flex items-center gap-2">
          <button
            className="wc-focus-ring rounded-xl bg-[var(--wc-ink)] px-2.5 py-1.5 text-xs text-white disabled:opacity-40"
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
          {saved && <span className="text-[11px] text-[var(--wc-sage-ink)]">已保存</span>}
        </div>
      </div>
    </PaperFrame>
  )
}

const SEARCH_CARD_STYLES = [
  'wc-paper-card wc-paper-sage wc-paper-shape-c',
  'wc-paper-card wc-paper-blue wc-paper-shape-d',
] as const

function providerDescription(provider: WebSearchProviderId): string {
  if (provider === 'tavily') {
    return '自动选择 general/news/finance 主题；搜索深度由质量档位固定，批量查询允许部分成功。'
  }
  return '固定 low 搜索上下文；密钥只在主进程解密使用。'
}
