import { useRef } from 'react'
import { PERMISSION_MODES, type PermissionMode } from '@whycode/core/permissions'
import type {
  ContextUsageInfo,
  ReasoningEffort,
  ReasoningEffortSelection,
} from '@whycode/core'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Image,
  Plus,
  ShieldCheck,
  Sparkles,
  Square,
  Users,
  Zap,
} from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { USER_IMAGE_ATTACHMENT_MAX_COUNT } from '@whycode/core/image-limits'
import type { ModelListItem } from '../../shared/settings.ts'
import { MAX_PDF_DRAFTS } from './pdf-draft.ts'
import { ContextUsageMeter } from './context-usage-meter.tsx'

interface ConsensusControl {
  ready: boolean
  reason: string | null
  enabled: boolean
}

interface ComposerToolbarProps {
  canAttachImages: boolean
  canAttachPdfs: boolean
  attachmentLocked: boolean
  configurationLocked: boolean
  permissionLocked: boolean
  permMode: PermissionMode
  consensus: ConsensusControl
  models: readonly ModelListItem[]
  modelId: string
  reasoningEffort: ReasoningEffortSelection
  contextUsage: ContextUsageInfo | null
  busy: boolean
  stopping: boolean
  stopDisabled: boolean
  sendDisabled: boolean
  onImageFiles: (files: FileList | null) => void
  onPdfFiles: (files: FileList | null) => void
  onPermissionChange: (mode: PermissionMode) => void
  onToggleConsensus: () => void
  onModelChange: (modelId: string) => void
  onReasoningEffortChange: (effort: ReasoningEffortSelection) => void
  onSend: () => void
  onStop: () => void
}

export function ComposerToolbar(props: ComposerToolbarProps) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-1">
        <AttachmentMenu {...props} />
        <PermissionMenu {...props} />
        <button
          type="button"
          className={`wc-composer-control wc-focus-ring flex h-8 items-center gap-1.5 rounded-xl px-2 transition-colors disabled:opacity-40 ${
            props.consensus.enabled
              ? 'bg-[var(--wc-sage)] text-[var(--wc-sage-ink)]'
              : 'text-[var(--wc-muted)] hover:bg-black/[0.045]'
          }`}
          disabled={props.configurationLocked || (!props.consensus.enabled && !props.consensus.ready)}
          onClick={props.onToggleConsensus}
          title={props.consensus.enabled
            ? '多 Agent 协商已开启'
            : props.consensus.reason ?? '开启多 Agent 协商'}
        >
          <Users size={14} />
          <span className="wc-composer-control-label">协商{props.consensus.enabled ? ' · 开' : ''}</span>
        </button>
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <ModelMenu {...props} />
        <ContextUsageMeter usage={props.contextUsage} />
        <button
          type="button"
          className="wc-focus-ring flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--wc-ink)] text-white shadow-sm transition-transform hover:-translate-y-0.5 disabled:cursor-default disabled:bg-[#a9aaa5] disabled:hover:translate-y-0"
          disabled={props.busy ? props.stopDisabled : props.sendDisabled}
          onClick={props.busy ? props.onStop : props.onSend}
          title={props.busy ? (props.stopping ? '停止中' : '停止') : '发送'}
          aria-label={props.busy ? (props.stopping ? '停止中' : '停止') : '发送'}
        >
          {props.busy ? <Square size={13} fill="currentColor" /> : <ArrowUp size={17} />}
        </button>
      </div>
    </div>
  )
}

function AttachmentMenu(props: ComposerToolbarProps) {
  const imageInputRef = useRef<HTMLInputElement>(null)
  const pdfInputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        disabled={!props.canAttachImages || props.attachmentLocked}
        onChange={(event) => {
          props.onImageFiles(event.currentTarget.files)
          event.currentTarget.value = ''
        }}
      />
      <input
        ref={pdfInputRef}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        className="hidden"
        disabled={!props.canAttachPdfs || props.attachmentLocked}
        onChange={(event) => {
          props.onPdfFiles(event.currentTarget.files)
          event.currentTarget.value = ''
        }}
      />
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="wc-icon-button"
            disabled={props.attachmentLocked || (!props.canAttachImages && !props.canAttachPdfs)}
            aria-label="添加附件"
            title="添加附件"
          >
            <Plus size={18} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="wc-menu-content" align="start" side="top" sideOffset={8}>
            <DropdownMenu.Item
              className="wc-menu-item"
              disabled={!props.canAttachImages || props.attachmentLocked}
              onSelect={() => imageInputRef.current?.click()}
            >
              <Image size={15} />
              <div>
                <div>添加图片</div>
                <div className="wc-type-tiny text-[var(--wc-faint)]">最多 {USER_IMAGE_ATTACHMENT_MAX_COUNT} 张，也支持粘贴和拖放</div>
              </div>
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="wc-menu-item"
              disabled={!props.canAttachPdfs || props.attachmentLocked}
              onSelect={() => pdfInputRef.current?.click()}
            >
              <FileText size={15} />
              <div>
                <div>添加 PDF</div>
                <div className="wc-type-tiny text-[var(--wc-faint)]">最多 {MAX_PDF_DRAFTS} 个</div>
              </div>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  )
}

function PermissionMenu(props: ComposerToolbarProps) {
  const selected = PERMISSION_MODES.find((mode) => mode.id === props.permMode)
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="wc-composer-control wc-focus-ring flex h-8 items-center gap-1.5 rounded-xl px-2 text-[var(--wc-sand-ink)] transition-colors hover:bg-[var(--wc-sand)] disabled:opacity-40"
          disabled={props.permissionLocked}
          title="权限档位"
        >
          <ShieldCheck size={14} />
          <span className="wc-composer-control-label">{selected?.label ?? '权限'}</span>
          <ChevronDown size={12} className="wc-composer-control-chevron" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="wc-menu-content" align="start" side="top" sideOffset={8}>
          <DropdownMenu.Label className="px-2 py-1 wc-type-tiny font-medium text-[var(--wc-faint)]">权限档位</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={props.permMode} onValueChange={(value) => props.onPermissionChange(value as PermissionMode)}>
            {PERMISSION_MODES.map((mode) => (
              <DropdownMenu.RadioItem key={mode.id} value={mode.id} className="wc-menu-item">
                <span className="flex size-4 items-center justify-center">
                  <DropdownMenu.ItemIndicator><Check size={14} /></DropdownMenu.ItemIndicator>
                </span>
                <div>
                  <div>{mode.label}</div>
                  <div className="wc-type-tiny text-[var(--wc-faint)]">{permissionDescription(mode.id)}</div>
                </div>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function ModelMenu(props: ComposerToolbarProps) {
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
  const availableModels = props.models.filter((model) => model.available && !model.retired)
  const label = selectedModel?.displayName ?? '选择模型'
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="wc-composer-control wc-focus-ring flex h-8 min-w-0 max-w-[18rem] items-center gap-1 rounded-xl px-2 text-[var(--wc-muted)] transition-colors hover:bg-black/[0.045] disabled:opacity-40"
          disabled={props.configurationLocked}
          title={`${label}${effort ? ` · 推理 ${reasoningEffortLabel(selectedEffort as ReasoningEffort)}` : ''}`}
        >
          <span className="truncate">{label}</span>
          {effort && <span className="shrink-0 text-[var(--wc-faint)]">{reasoningEffortLabel(selectedEffort as ReasoningEffort)}</span>}
          <ChevronDown size={13} className="shrink-0" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="wc-menu-content min-w-56" align="end" side="top" sideOffset={8}>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="wc-menu-item">
              <Sparkles size={15} />
              <span className="flex-1">模型</span>
              <span className="max-w-32 truncate text-[var(--wc-faint)]">{label}</span>
              <ChevronRight size={14} />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className="wc-menu-content min-w-64" sideOffset={8}>
                <DropdownMenu.RadioGroup value={props.modelId} onValueChange={props.onModelChange}>
                  {availableModels.map((model) => (
                    <DropdownMenu.RadioItem key={model.id} value={model.id} className="wc-menu-item">
                      <span className="flex size-4 items-center justify-center">
                        <DropdownMenu.ItemIndicator><Check size={14} /></DropdownMenu.ItemIndicator>
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{model.displayName}</div>
                        <div className="wc-type-tiny text-[var(--wc-faint)]">
                          {model.imageInputMode === 'native' ? '原生图片' : model.imageInputMode === 'auxiliary' ? '辅助识图' : '文本'}
                        </div>
                      </div>
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="wc-menu-item" disabled={!effort}>
              <Zap size={15} />
              <span className="flex-1">推理强度</span>
              <span className="text-[var(--wc-faint)]">{effort ? reasoningEffortLabel(selectedEffort as ReasoningEffort) : '默认'}</span>
              <ChevronRight size={14} />
            </DropdownMenu.SubTrigger>
            {effort && (
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className="wc-menu-content min-w-44" sideOffset={8}>
                  <DropdownMenu.RadioGroup
                    value={selectedEffort}
                    onValueChange={(value) => props.onReasoningEffortChange(value as ReasoningEffortSelection)}
                  >
                    {effort.supported.map((level) => (
                      <DropdownMenu.RadioItem key={level} value={level} className="wc-menu-item">
                        <span className="flex size-4 items-center justify-center">
                          <DropdownMenu.ItemIndicator><Check size={14} /></DropdownMenu.ItemIndicator>
                        </span>
                        {reasoningEffortLabel(level)}
                      </DropdownMenu.RadioItem>
                    ))}
                  </DropdownMenu.RadioGroup>
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            )}
          </DropdownMenu.Sub>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

function permissionDescription(mode: PermissionMode): string {
  if (mode === 'readonly') return '只读探索，写入与执行直接停止'
  if (mode === 'default') return '编辑和命令按边界询问'
  if (mode === 'acceptEdits') return '自动接受项目内文件编辑'
  return '在既定安全边界内自动执行'
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
