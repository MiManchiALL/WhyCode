import { SshSettings } from './ssh-settings.tsx'
import { RetainedWorkspacesSettings } from './retained-workspaces-settings.tsx'
import type { RetainedWorkspaceCleanup } from './retained-workspace-cleanup.ts'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { ReasoningEffort, ReasoningEffortCapability } from '@whycode/core'
import {
  ArrowLeft,
  Bot,
  BrainCircuit,
  Folder,
  Globe2,
  Plug,
  Server,
  Settings,
  UsersRound,
} from 'lucide-react'
import * as Dialog from '@radix-ui/react-dialog'
import type {
  AddMcpServerRequest,
  CliProxyApiSettingsItem,
  ConnectionSettingsSnapshot,
  McpSettingsItem,
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
import { RemoteMcpEditor } from './remote-mcp-editor.tsx'
import type { RemoteMcpDocument } from '../../shared/ssh-mcp.ts'
import {
  SettingsButton,
  SettingsPanel,
  SettingsSection,
} from './settings-layout.tsx'
import { SelectMenu } from './select-menu.tsx'
import { WebSearchSettingsEditor } from './web-search-settings.tsx'
import { GeneralSettings } from './general-settings.tsx'
import { useConversationFeedback } from './conversation-feedback.tsx'
import type { StartWorkspaceRequest } from '../../shared/workspace.ts'

interface ConnectionSettingsPanelProps {
  initialSection?: 'general' | 'ssh'
  workspaceCleanup: RetainedWorkspaceCleanup
  conversationFontSize: number
  onConversationFontSizeChange: (value: number) => void
  onError: (message: string) => void
  onClose: () => void
  onChanged: () => void
  onStartSession: (workspace: StartWorkspaceRequest) => Promise<boolean>
}

export function ConnectionSettingsPanel(props: ConnectionSettingsPanelProps) {
  const [open, setOpen] = useState(true)
  const feedback = useConversationFeedback()
  const [pending, setPending] = useState(false)
  const [snapshot, setSnapshot] = useState<ConnectionSettingsSnapshot | null>(null)
  const [mcpSnapshot, setMcpSnapshot] = useState<McpSettingsItem | null>(null)
  const [readState, setReadState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [mcpDocument, setMcpDocument] = useState<RemoteMcpDocument | null>(null)
  const [section, setSection] = useState<SettingsSectionId>(props.initialSection ?? 'general')
  const needsSnapshot = !['general', 'ssh', 'workspaces'].includes(section)
  const refreshGeneration = useRef(0)

  const requestClose = () => {
    if (!pending) setOpen(false)
  }

  const receiveConnections = (next: ConnectionSettingsSnapshot) => {
    setSnapshot(next)
    props.onChanged()
  }

  const mutate = async <T,>(operation: () => Promise<SettingsMutationResult<T>>, receive: (snapshot: T) => void, oauth = false) => {
    refreshGeneration.current++
    setReadState('ready')
    setPending(true)
    try {
      const result = await operation()
      if (!result.ok || !result.snapshot) {
        props.onError(result.error ?? (oauth ? 'OAuth 登录失败' : '设置保存失败'))
        return false
      }
      receive(result.snapshot)
      feedback('success', oauth ? 'OAuth 登录成功' : '设置已保存')
      return true
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setPending(false)
    }
  }

  const refresh = useEffectEvent(async () => {
    if (pending) return
    const generation = ++refreshGeneration.current
    setReadState('loading')
    try {
      if (section === 'mcp') {
        const next = await window.whycode.mcpSettings()
        if (generation === refreshGeneration.current) setMcpSnapshot(next)
      } else {
        const next = await window.whycode.connectionSettings()
        if (generation === refreshGeneration.current) receiveConnections(next)
      }
      if (generation === refreshGeneration.current) setReadState('ready')
    } catch (cause) {
      if (generation === refreshGeneration.current) {
        setReadState('failed')
        props.onError(cause instanceof Error ? cause.message : String(cause))
      }
    }
  })

  useEffect(() => {
    if (!open || !needsSnapshot) return
    const onFocus = () => { void refresh() }
    onFocus()
    window.addEventListener('focus', onFocus)
    return () => { refreshGeneration.current++; setReadState('loading'); window.removeEventListener('focus', onFocus) }
  }, [open, section, needsSnapshot])

  const openMcpConfig = async (request: OpenMcpConfigRequest) => {
    try {
      const result = await window.whycode.openMcpConfig(request)
      if (!result.ok) props.onError(result.error ?? '无法打开 MCP 配置文件')
      else if (result.document) setMcpDocument(result.document)
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const hasSnapshot = section === 'mcp' ? mcpSnapshot !== null : snapshot !== null
  const disabled = pending || readState === 'loading'

  return (
    <><Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) requestClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Content
          className="wc-dialog-page wc-settings"
          onEscapeKeyDown={event => { if (event.isComposing) event.preventDefault() }}
          onAnimationEnd={(event) => {
            if (
              event.target === event.currentTarget
              && event.currentTarget.dataset.state === 'closed'
            ) props.onClose()
          }}
        >
          <aside className="wc-settings-sidebar">
            <button
              type="button"
              className="wc-settings-back wc-focus-ring"
              onClick={requestClose}
              disabled={pending}
            >
              <ArrowLeft size={16} />
              返回 WhyCode
            </button>
            <div className="wc-settings-sidebar-title">设置</div>
            <nav className="wc-settings-nav wc-scrollbar" aria-label="设置分类">
              <SettingsNavItem disabled={pending} active={section === 'general'} icon={<Settings size={16} />} label="通用" onClick={() => setSection('general')} />
              <SettingsNavItem
                disabled={pending}
                active={section === 'models'}
                icon={<Bot size={16} />}
                label="模型连接"
                onClick={() => setSection('models')}
              />
              <SettingsNavItem
                disabled={pending}
                active={section === 'auxiliary'}
                icon={<BrainCircuit size={16} />}
                label="辅助模型"
                onClick={() => setSection('auxiliary')}
              />
              <SettingsNavItem
                disabled={pending}
                active={section === 'consensus'}
                icon={<UsersRound size={16} />}
                label="协商模型"
                onClick={() => setSection('consensus')}
              />
              <SettingsNavItem
                disabled={pending}
                active={section === 'search'}
                icon={<Globe2 size={16} />}
                label="网页搜索"
                onClick={() => setSection('search')}
              />
              <SettingsNavItem
                disabled={pending}
                active={section === 'mcp'}
                icon={<Plug size={16} />}
                label="MCP"
                onClick={() => setSection('mcp')}
              />
              <SettingsNavItem disabled={pending} active={section === 'ssh'} icon={<Server size={16} />} label="SSH 连接" onClick={() => setSection('ssh')} />
              <SettingsNavItem disabled={pending} active={section === 'workspaces'} icon={<Folder size={16} />} label="保留工作区" onClick={() => setSection('workspaces')} />
            </nav>
          </aside>

          <main className="wc-settings-main">
            <div key={section} className="wc-settings-scroll wc-scrollbar">
              <div className="wc-settings-content">
                <header className="wc-settings-heading">
                  <Dialog.Title>{SETTINGS_META[section].title}</Dialog.Title>
                  <Dialog.Description>{SETTINGS_META[section].description}</Dialog.Description>
                </header>

                <div className="wc-settings-sections" aria-busy={needsSnapshot && readState === 'loading'}>
                  {needsSnapshot && !hasSnapshot && <p role="status" className="text-sm text-[var(--wc-muted)]">
                    {readState === 'failed' ? '设置暂不可用，请重新进入此分类重试。' : '正在读取设置…'}
                  </p>}
                  {section === 'ssh' && <SshSettings onSelectProject={async workspace => {
                    const started = await props.onStartSession(workspace)
                    if (started) requestClose()
                    return started
                  }} />}
                  {section === 'general' && <GeneralSettings fontSize={props.conversationFontSize} onFontSizeChange={props.onConversationFontSizeChange} />}
                  {section === 'workspaces' && <RetainedWorkspacesSettings cleanup={props.workspaceCleanup} onError={props.onError} />}
                  {section === 'models' && snapshot && (
                    <>
                      <BuiltInProvidersEditor
                        providers={snapshot.providers}
                        disabled={disabled}
                        onSave={(request) => mutate(() => window.whycode.saveProviderSettings(request), receiveConnections)}
                      />
                      <CliProxyApiEditor
                        settings={snapshot.cliProxyApi}
                        disabled={disabled}
                        onSave={(request) => mutate(() => window.whycode.saveCliProxyApiSettings(request), receiveConnections)}
                      />
                    </>
                  )}

                  {section === 'auxiliary' && snapshot && (
                    <AuxiliaryModelsEditor
                      settings={snapshot.auxiliaryModels}
                      disabled={disabled}
                      onSave={(request) => mutate(() =>
                        window.whycode.saveAuxiliaryModelSettings(request), receiveConnections)}
                    />
                  )}

                  {section === 'consensus' && snapshot && (
                    <ConsensusModelsEditor
                      settings={snapshot.consensusModels}
                      disabled={disabled}
                      onSave={(request) => mutate(() =>
                        window.whycode.saveConsensusModelSettings(request), receiveConnections)}
                    />
                  )}

                  {section === 'search' && snapshot && (
                    <WebSearchSettingsEditor
                      settings={snapshot.webSearch}
                      disabled={disabled}
                      onSave={(request) => mutate(() => window.whycode.saveWebSearchSettings(request), receiveConnections)}
                    />
                  )}

                  {section === 'mcp' && mcpSnapshot && (
                    <McpSettingsEditor
                      settings={mcpSnapshot}
                      disabled={disabled}
                      onSetEnabled={(request: SetMcpServerEnabledRequest) =>
                        mutate(() => window.whycode.setMcpServerEnabled(request), setMcpSnapshot)}
                      onAddServer={(request: AddMcpServerRequest) =>
                        mutate(() => window.whycode.addMcpServer(request), setMcpSnapshot)}
                      onSaveSecretHeader={(request: SaveMcpSecretHeaderRequest) =>
                        mutate(() => window.whycode.saveMcpSecretHeader(request), setMcpSnapshot)}
                      onAuthorizeOAuth={(request: McpOAuthRequest) =>
                        mutate(() => window.whycode.authorizeMcpOAuth(request), setMcpSnapshot, true)}
                      onDisconnectOAuth={(request: McpOAuthRequest) =>
                        mutate(() => window.whycode.disconnectMcpOAuth(request), setMcpSnapshot)}
                      onOpenConfig={openMcpConfig}
                    />
                  )}
                </div>
              </div>
            </div>
          </main>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    {mcpDocument && <RemoteMcpEditor document={mcpDocument} onClose={() => setMcpDocument(null)} onSaved={result => {
      refreshGeneration.current++
      setReadState('ready')
      if (result.snapshot) setMcpSnapshot(result.snapshot)
      feedback('success', '项目 MCP 配置已保存')
    }} />}</>
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

type SettingsSectionId = 'ssh' | 'general' | 'models' | 'auxiliary' | 'consensus' | 'search' | 'mcp' | 'workspaces'

const SETTINGS_META: Record<SettingsSectionId, { title: string; description: string }> = {
  ssh: { title: 'SSH 连接', description: '管理服务器连接与远端项目。模型与会话记录保存在这台电脑。' },
  general: { title: '通用', description: '调整 WhyCode 的通用偏好。' },
  workspaces: { title: '保留工作区', description: '最后一个关联会话删除后留下的工作目录。重新关联会话后，会从此列表移出。' },
  models: {
    title: '模型连接',
    description: '管理内置厂商与 CLIProxyAPI，并选择可用于会话的模型。',
  },
  auxiliary: {
    title: '辅助模型',
    description: '分别配置图片理解与子代理任务使用的模型连接。',
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
  disabled: boolean
  active: boolean
  icon: React.ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      className="wc-settings-nav-item wc-focus-ring"
      aria-current={props.active ? 'page' : undefined}
      onClick={props.onClick}
    >
      {props.icon}
      <span className="flex-1">{props.label}</span>
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
  const submit = async (clearApiKey = false) => {
    const ok = await props.onSave({
      providerId: props.provider.id,
      apiKey,
      clearApiKey,
      baseURL,
    })
    if (ok) setApiKey('')
  }
  return (
    <SettingsPanel>
      <div className="wc-settings-provider">
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
          <label className="block wc-type-caption text-neutral-600">API Key（留空保留现有密钥）
            <input className="wc-settings-input mt-1" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={props.disabled} autoComplete="new-password" />
          </label>
          <label className="mt-3 block wc-type-caption text-neutral-600">Base URL（留空使用官方端点；也可填写保持该厂商协议的中转地址）
            <input className="wc-settings-input mt-1" value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder={props.provider.defaultBaseURL} disabled={props.disabled} />
          </label>
        </div>
        <div className="wc-settings-provider-actions">
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
  const toggleModel = (modelId: string) => {
    setModelIds((current) => {
      const next = new Set(current)
      if (next.has(modelId)) next.delete(modelId)
      else next.add(modelId)
      return next
    })
  }
  const submit = async (clearApiKey = false) => {
    const ok = await props.onSave({
      baseURL,
      apiKey,
      clearApiKey,
      modelIds: props.settings.models
        .filter((model) => modelIds.has(model.id))
        .map((model) => model.id),
    })
    if (ok) setApiKey('')
  }

  return (
    <SettingsSection
      title="CLIProxyAPI"
      description="只开放已确认与 WhyCode 型号等价的 CLIProxyAPI 路由；启用后以“（CLIProxyAPI）”区分连接来源。"
      actions={<ConnectionStatus configured={props.settings.hasKey} />}
    >
      <SettingsPanel>
        <div className="wc-settings-columns">
          <label className="block wc-type-caption text-neutral-600">
            Base URL（API 根地址，通常以 /v1 结尾）
            <input className="wc-settings-input mt-1" value={baseURL} onChange={(event) => setBaseURL(event.target.value)} placeholder="http://127.0.0.1:8317/v1" disabled={props.disabled} />
          </label>
          <label className="block wc-type-caption text-neutral-600">
            API Key（留空保留现有密钥）
            <input className="wc-settings-input mt-1" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} disabled={props.disabled} autoComplete="new-password" />
          </label>
        </div>
        <p className="mt-3 wc-type-caption font-medium text-neutral-600">启用模型</p>
        <div className="wc-settings-model-options mt-2">
          {props.settings.models.map((model) => (
            <label key={model.id} className="wc-settings-model-option text-xs">
              <input type="checkbox" className="mt-0.5" checked={modelIds.has(model.id)} onChange={() => toggleModel(model.id)} disabled={props.disabled} />
              <span>
                <span className="block text-neutral-800">{model.displayName}</span>
                {model.unavailableReason && (
                  <span className="block wc-type-tiny text-[var(--wc-muted)]">{model.unavailableReason}</span>
                )}
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
