import { useEffect, useState } from 'react'
import type { ReasoningEffort, ReasoningEffortCapability } from '@whycode/core'
import {
  ArrowLeft,
  Bot,
  BrainCircuit,
  Check,
  Globe2,
  Plug,
  RefreshCw,
  Settings,
  UsersRound,
} from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import type {
  AddMcpServerRequest,
  CliProxyApiSettingsItem,
  ConnectionSettingsSnapshot,
  McpOAuthRequest,
  OpenMcpConfigRequest,
  ProviderSettingsItem,
  SaveCliProxyApiSettingsRequest,
  SaveProviderSettingsRequest,
  SaveMcpSecretHeaderRequest,
  SetMcpServerEnabledRequest,
  SettingsMutationResult,
} from '../../shared/settings.ts'
import {
  AuxiliaryModelsEditor,
  ConsensusModelsEditor,
} from './agent-model-settings.tsx'
import { McpSettingsEditor } from './mcp-settings.tsx'
import {
  SettingsButton,
  SettingsPanel,
  SettingsSection,
} from './settings-layout.tsx'
import { SelectMenu } from './select-menu.tsx'
import { WebSearchSettingsEditor } from './web-search-settings.tsx'

interface ConnectionSettingsPanelProps {
  snapshot: ConnectionSettingsSnapshot
  onClose: () => void
  onChanged: (snapshot: ConnectionSettingsSnapshot) => void
}

export function ConnectionSettingsPanel(props: ConnectionSettingsPanelProps) {
  const [open, setOpen] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [oauthPending, setOauthPending] = useState(false)
  const [section, setSection] = useState<SettingsSectionId>('models')

  const requestClose = () => {
    if (!pending && !oauthPending) setOpen(false)
  }

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

  const mutateOAuth = async (operation: () => Promise<SettingsMutationResult>) => {
    setOauthPending(true)
    setError(null)
    try {
      const result = await operation()
      if (!result.ok || !result.snapshot) {
        setError(result.error ?? 'OAuth 登录失败')
        return false
      }
      props.onChanged(result.snapshot)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setOauthPending(false)
    }
  }

  const refresh = async () => {
    setPending(true)
    setError(null)
    try {
      props.onChanged(await window.whycode.connectionSettings())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  const openMcpConfig = async (request: OpenMcpConfigRequest) => {
    setError(null)
    try {
      const result = await window.whycode.openMcpConfig(request)
      if (!result.ok) setError(result.error ?? '无法打开 MCP 配置文件')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) requestClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Content
          className="wc-dialog-page wc-settings fixed inset-0 z-50 flex gap-1 overflow-hidden bg-[var(--wc-canvas)] p-1 text-[var(--wc-ink)] outline-none"
          onAnimationEnd={(event) => {
            if (
              event.target === event.currentTarget
              && event.currentTarget.dataset.state === 'closed'
            ) props.onClose()
          }}
        >
          <aside className="wc-shell-panel flex w-[240px] shrink-0 flex-col bg-[var(--wc-sidebar)] p-3">
            <button
              type="button"
              className="wc-focus-ring flex h-10 items-center gap-2 rounded-[var(--wc-menu-radius)] px-2.5 text-sm text-[var(--wc-muted)] hover:bg-black/[0.04] hover:text-[var(--wc-ink)]"
              onClick={requestClose}
              disabled={pending || oauthPending}
            >
              <ArrowLeft size={16} />
              返回 WhyCode
            </button>
            <div className="mt-5 px-2 text-lg font-semibold tracking-tight">设置</div>
            <nav className="mt-4 space-y-1" aria-label="设置分类">
              <SettingsNavItem
                active={section === 'models'}
                icon={<Bot size={16} />}
                label="模型连接"
                onClick={() => setSection('models')}
              />
              <SettingsNavItem
                active={section === 'auxiliary'}
                icon={<BrainCircuit size={16} />}
                label="辅助模型"
                onClick={() => setSection('auxiliary')}
              />
              <SettingsNavItem
                active={section === 'consensus'}
                icon={<UsersRound size={16} />}
                label="协商模型"
                onClick={() => setSection('consensus')}
              />
              <SettingsNavItem
                active={section === 'search'}
                icon={<Globe2 size={16} />}
                label="网页搜索"
                onClick={() => setSection('search')}
              />
              <SettingsNavItem
                active={section === 'mcp'}
                icon={<Plug size={16} />}
                label="MCP"
                onClick={() => setSection('mcp')}
              />
            </nav>
            <div className="mt-auto flex items-center gap-2 rounded-[var(--wc-menu-radius)] bg-black/[0.035] px-3 py-2 wc-type-tiny text-[var(--wc-faint)]">
              <Settings size={13} />
              设置保存后立即作用于模型列表
            </div>
          </aside>

          <main className="wc-shell-panel min-w-0 flex-1 bg-[var(--wc-surface)]">
            <div className="wc-scrollbar h-full overflow-y-auto">
              <div className="mx-auto w-full max-w-5xl px-8 py-10 lg:px-12">
                <header className="mb-8 flex items-start justify-between gap-4">
                  <div>
                    <Dialog.Title className="text-xl font-semibold tracking-tight">{SETTINGS_META[section].title}</Dialog.Title>
                    <Dialog.Description className="mt-1.5 text-[13px] leading-5 text-[var(--wc-muted)]">{SETTINGS_META[section].description}</Dialog.Description>
                  </div>
                  <SettingsButton
                    onClick={() => void refresh()}
                    disabled={pending || oauthPending}
                  >
                    <RefreshCw size={14} className={pending ? 'animate-spin' : ''} />
                    刷新
                  </SettingsButton>
                </header>

                {error && (
                  <p className="mb-5 rounded-xl border border-[#dec8bf] bg-[#f3e8e3] px-3 py-2 text-xs text-[var(--wc-danger)]" role="alert">
                    {error}
                  </p>
                )}

                <div className="space-y-6">
                  {section === 'models' && (
                    <>
                      <BuiltInProvidersEditor
                        providers={props.snapshot.providers}
                        disabled={pending || oauthPending}
                        onSave={(request) => mutate(() => window.whycode.saveProviderSettings(request))}
                      />
                      <CliProxyApiEditor
                        settings={props.snapshot.cliProxyApi}
                        disabled={pending || oauthPending}
                        onSave={(request) => mutate(() => window.whycode.saveCliProxyApiSettings(request))}
                      />
                    </>
                  )}

                  {section === 'auxiliary' && (
                    <AuxiliaryModelsEditor
                      settings={props.snapshot.auxiliaryModels}
                      disabled={pending || oauthPending}
                      onSave={(request) => mutate(() =>
                        window.whycode.saveAuxiliaryModelSettings(request))}
                    />
                  )}

                  {section === 'consensus' && (
                    <ConsensusModelsEditor
                      settings={props.snapshot.consensusModels}
                      disabled={pending || oauthPending}
                      onSave={(request) => mutate(() =>
                        window.whycode.saveConsensusModelSettings(request))}
                    />
                  )}

                  {section === 'search' && (
                    <WebSearchSettingsEditor
                      settings={props.snapshot.webSearch}
                      disabled={pending || oauthPending}
                      onSave={(request) => mutate(() => window.whycode.saveWebSearchSettings(request))}
                    />
                  )}

                  {section === 'mcp' && (
                    <McpSettingsEditor
                      settings={props.snapshot.mcp}
                      disabled={pending || oauthPending}
                      onSetEnabled={(request: SetMcpServerEnabledRequest) =>
                        mutate(() => window.whycode.setMcpServerEnabled(request))}
                      onAddServer={(request: AddMcpServerRequest) =>
                        mutate(() => window.whycode.addMcpServer(request))}
                      onSaveSecretHeader={(request: SaveMcpSecretHeaderRequest) =>
                        mutate(() => window.whycode.saveMcpSecretHeader(request))}
                      onAuthorizeOAuth={(request: McpOAuthRequest) =>
                        mutateOAuth(() => window.whycode.authorizeMcpOAuth(request))}
                      onDisconnectOAuth={(request: McpOAuthRequest) =>
                        mutate(() => window.whycode.disconnectMcpOAuth(request))}
                      onOpenConfig={openMcpConfig}
                      onRefresh={refresh}
                    />
                  )}
                </div>
              </div>
            </div>
          </main>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function BuiltInProvidersEditor(props: {
  providers: ProviderSettingsItem[]
  disabled: boolean
  onSave: (request: SaveProviderSettingsRequest) => Promise<boolean>
}) {
  const defaultProvider = props.providers.find((provider) => provider.id === 'deepseek')
    ?? props.providers[0]
  const [selectedProviderId, setSelectedProviderId] = useState(defaultProvider?.id ?? '')
  const selectedProvider = props.providers.find(
    (provider) => provider.id === selectedProviderId,
  ) ?? defaultProvider

  return (
    <SettingsSection
      title="内置厂商"
      description="选择一个厂商，查看其模型并配置官方端点或兼容该协议的中转地址。"
      actions={props.providers.length > 0 ? (
        <div className="min-w-52 wc-type-caption text-neutral-600">
          <span className="mb-1 block">当前厂商</span>
          <SelectMenu
            value={selectedProvider?.id ?? ''}
            options={props.providers.map((provider) => ({
              value: provider.id,
              label: `${provider.displayName}${provider.hasKey ? '' : '（未配置）'}`,
            }))}
            onValueChange={(value) => setSelectedProviderId(value as ProviderSettingsItem['id'])}
            ariaLabel="内置模型厂商"
            disabled={props.disabled}
            align="end"
            className="w-full"
          />
        </div>
      ) : undefined}
    >
      {selectedProvider ? (
        <ProviderEditor
          key={selectedProvider.id}
          provider={selectedProvider}
          disabled={props.disabled}
          onSave={props.onSave}
        />
      ) : (
        <SettingsPanel>
          <p className="wc-type-caption text-[var(--wc-muted)]">没有可配置的内置厂商。</p>
        </SettingsPanel>
      )}
    </SettingsSection>
  )
}

type SettingsSectionId = 'models' | 'auxiliary' | 'consensus' | 'search' | 'mcp'

const SETTINGS_META: Record<SettingsSectionId, { title: string; description: string }> = {
  models: {
    title: '模型连接',
    description: '管理内置厂商与 CLIProxyAPI，并选择可用于会话的模型。',
  },
  auxiliary: {
    title: '辅助模型',
    description: '为非视觉主模型选择按需调用的辅助识图模型。',
  },
  consensus: {
    title: '协商模型',
    description: '从统一模型连接中选择协商评审员 B 和 C 使用的模型。',
  },
  search: {
    title: '网页搜索',
    description: '配置 Agent 联网检索时使用的搜索服务。',
  },
  mcp: {
    title: 'MCP',
    description: '管理 Model Context Protocol 服务、密钥和 OAuth 连接。',
  },
}

function SettingsNavItem(props: {
  active: boolean
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`wc-focus-ring flex h-10 w-full items-center gap-2.5 rounded-[var(--wc-menu-radius)] px-3 text-left text-sm transition-colors ${
        props.active
          ? 'bg-black/[0.055] text-[var(--wc-ink)]'
          : 'text-[var(--wc-muted)] hover:bg-black/[0.04] hover:text-[var(--wc-ink)]'
      }`}
      onClick={props.onClick}
    >
      {props.icon}
      <span className="flex-1">{props.label}</span>
      {props.active && <Check size={14} className="text-[var(--wc-sage-ink)]" />}
    </button>
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
    <SettingsPanel>
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(22rem,1.2fr)] lg:items-start">
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{props.provider.displayName}</p>
              <p className="wc-type-caption text-neutral-500">{props.provider.protocolLabel}</p>
            </div>
            <ConnectionStatus configured={props.provider.hasKey} />
          </div>
          <div className="mt-3 space-y-1">
            {props.provider.models.map((model) => (
              <p key={model.id} className="wc-type-caption text-neutral-500">
                {model.displayName}
                {' · '}{model.capabilities.supportsImageInput ? '图片' : '仅文本'}
                {' · '}{formatTokenLimit(model.capabilities.contextWindow)} 上下文
                {' · '}{formatTokenLimit(model.capabilities.maxOutput)} 输出
                {' · '}{model.capabilities.reasoningExposure === 'none' ? '无推理透传' : '推理'}
              </p>
            ))}
          </div>
        </div>
        <div className="min-w-0">
          <label className="block wc-type-caption text-neutral-600">API Key（留空保留现有密钥）</label>
          <input className="wc-settings-input mt-1" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={props.disabled} autoComplete="new-password" />
          <label className="mt-3 block wc-type-caption text-neutral-600">Base URL（留空使用官方端点；也可填写保持该厂商协议的中转地址）</label>
          <input className="wc-settings-input mt-1" value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder={props.provider.defaultBaseURL} disabled={props.disabled} />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 lg:col-start-2">
          {saved && <span className="wc-type-caption text-[var(--wc-sage-ink)]">已保存</span>}
          {props.provider.hasKey && <SettingsButton variant="danger" onClick={() => void submit(true)} disabled={props.disabled}>清除密钥</SettingsButton>}
          <SettingsButton variant="primary" onClick={() => void submit()} disabled={props.disabled}>保存</SettingsButton>
        </div>
      </div>
    </SettingsPanel>
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
    <SettingsSection
      title="CLIProxyAPI"
      description="只开放已确认与 WhyCode 型号等价的 CLIProxyAPI 路由；启用后以“（CLIProxyAPI）”区分连接来源。"
      actions={<ConnectionStatus configured={props.settings.hasKey} />}
    >
      <SettingsPanel>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block wc-type-caption text-neutral-600">
            Base URL
            <input className="wc-settings-input mt-1" value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder="http://127.0.0.1:8317/v1" disabled={props.disabled} />
          </label>
          <label className="block wc-type-caption text-neutral-600">
            API Key（留空保留现有密钥）
            <input className="wc-settings-input mt-1" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={props.disabled} autoComplete="new-password" />
          </label>
        </div>
        <p className="mt-3 wc-type-caption font-medium text-neutral-600">启用模型</p>
        <div className="mt-1 grid gap-1.5 md:grid-cols-2">
          {props.settings.models.map((model) => (
            <label key={model.id} className="flex items-start gap-2 rounded-xl border border-[var(--wc-line)] bg-white/60 px-2.5 py-2 text-xs">
              <input type="checkbox" className="mt-0.5" checked={modelIds.has(model.id)} onChange={() => toggleModel(model.id)} disabled={props.disabled} />
              <span>
                <span className="block text-neutral-800">{model.displayName}</span>
                <span className="block wc-type-tiny text-neutral-500">
                  {model.capabilities.supportsImageInput ? '图片' : '仅文本'}
                  {' · '}{formatTokenLimit(model.capabilities.contextWindow)} 上下文
                  {' · '}{formatTokenLimit(model.capabilities.maxOutput)} 输出
                  {' · '}{reasoningEffortSummary(model.capabilities.reasoningEffort)}
                </span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-2 wc-type-caption text-neutral-500">推理强度在顶部随当前会话选择；WhyCode 会按所选型号限制档位，并通过对应协议传给 CLIProxyAPI。</p>
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {saved && <span className="wc-type-caption text-[var(--wc-sage-ink)]">已保存</span>}
          {props.settings.hasKey && <SettingsButton variant="danger" onClick={() => void submit(true)} disabled={props.disabled}>清除密钥</SettingsButton>}
          <SettingsButton variant="primary" onClick={() => void submit()} disabled={props.disabled}>保存</SettingsButton>
        </div>
      </SettingsPanel>
    </SettingsSection>
  )
}

function ConnectionStatus(props: { configured: boolean }) {
  return (
    <span className={`shrink-0 whitespace-nowrap rounded-lg px-1.5 py-0.5 wc-type-tiny ${props.configured ? 'bg-[var(--wc-sage)] text-[var(--wc-sage-ink)]' : 'bg-black/[0.045] text-[var(--wc-muted)]'}`}>
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
