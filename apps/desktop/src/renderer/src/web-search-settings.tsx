import { useState } from 'react'
import type {
  SaveWebSearchSettingsRequest,
  TavilySearchDepth,
  WebSearchProviderId,
  WebSearchSettingsItem,
} from '../../shared/settings.ts'
import { SelectMenu } from './select-menu.tsx'
import {
  SettingsActionRow,
  SettingsButton,
  SettingsPanel,
  SettingsRow,
  SettingsSection,
} from './settings-layout.tsx'

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
    <SettingsSection
      title="网页搜索"
      description="Agent 始终使用统一 WebSearch 工具；这里选择实际提供搜索结果的后端。"
      actions={
        <div className="min-w-44 wc-type-caption text-neutral-600">
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
      }
    >
      <SettingsPanel padded={false}>
        {props.settings.providers.map((provider, index) => (
          <SearchProviderEditor
            key={provider.id}
            provider={provider}
            divided={index > 0}
            active={provider.id === props.settings.activeProvider}
            disabled={props.disabled}
            onSave={props.onSave}
          />
        ))}
      </SettingsPanel>
    </SettingsSection>
  )
}

function SearchProviderEditor(props: {
  provider: SearchProvider
  divided: boolean
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
    <section className={props.divided ? 'border-t border-[var(--wc-line-strong)]' : undefined}>
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3 px-4 pb-2 pt-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{props.provider.displayName}</p>
          <p className="mt-0.5 wc-type-caption text-neutral-500">
            {providerDescription(props.provider.id)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {props.active && props.provider.hasKey && (
            <span className="whitespace-nowrap rounded-lg bg-[var(--wc-blue)] px-1.5 py-0.5 wc-type-tiny text-[var(--wc-blue-ink)]">
              当前
            </span>
          )}
          <span className={`whitespace-nowrap rounded-lg px-1.5 py-0.5 wc-type-tiny ${props.provider.hasKey ? 'bg-[var(--wc-sage)] text-[var(--wc-sage-ink)]' : 'bg-black/[0.045] text-[var(--wc-muted)]'}`}>
            {props.provider.hasKey ? '已配置' : '未配置'}
          </span>
        </div>
      </header>
      <SettingsRow
        label="API Key"
        description="留空保存时保留当前密钥。"
        divided={false}
      >
        <input
          className="wc-settings-input"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          disabled={props.disabled}
          autoComplete="new-password"
          placeholder={props.provider.id === 'tavily' ? 'tvly-…' : 'pplx-…'}
        />
      </SettingsRow>
      {props.provider.id === 'tavily' && (
        <SettingsRow
          label="搜索质量"
          description="更高质量会消耗更多搜索额度。"
          divided={false}
        >
          <SelectMenu
            value={searchDepth}
            options={TAVILY_DEPTH_OPTIONS}
            onValueChange={(value) => setSearchDepth(value as TavilySearchDepth)}
            ariaLabel="Tavily 搜索质量"
            disabled={props.disabled}
            className="w-full"
          />
        </SettingsRow>
      )}
      <SettingsActionRow divided={false}>
        {saved && <span className="wc-type-caption text-[var(--wc-sage-ink)]">已保存</span>}
        {props.provider.hasKey && (
          <SettingsButton
            variant="danger"
            onClick={() => void submit(true)}
            disabled={props.disabled}
          >
            清除密钥
          </SettingsButton>
        )}
        <SettingsButton
          variant="primary"
          onClick={() => void submit()}
          disabled={props.disabled}
        >
          保存
        </SettingsButton>
      </SettingsActionRow>
    </section>
  )
}

function providerDescription(provider: WebSearchProviderId): string {
  if (provider === 'tavily') {
    return '自动选择 general/news/finance 主题；搜索深度由质量档位固定，批量查询允许部分成功。'
  }
  return '固定 low 搜索上下文；密钥只在主进程解密使用。'
}
