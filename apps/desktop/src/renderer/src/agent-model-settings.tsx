import { useEffect, useState } from 'react'
import type {
  AuxiliaryModelsSettingsItem,
  ConsensusModelsSettingsItem,
  SaveAuxiliaryModelSettingsRequest,
  SaveConsensusModelSettingsRequest,
} from '../../shared/settings.ts'
import { PaperFrame } from './paper-frame.tsx'
import { SelectMenu } from './select-menu.tsx'

export function AuxiliaryModelsEditor(props: {
  settings: AuxiliaryModelsSettingsItem
  disabled: boolean
  onSave: (request: SaveAuxiliaryModelSettingsRequest) => Promise<boolean>
}) {
  const [visionModelId, setVisionModelId] = useState(props.settings.visionModelId ?? '')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    setVisionModelId(props.settings.visionModelId ?? '')
  }, [props.settings.visionModelId])

  const submit = async () => {
    setSaved(false)
    if (await props.onSave({ visionModelId: visionModelId || null })) setSaved(true)
  }

  return (
    <section className="wc-paper-section">
      <div>
        <h3 className="text-sm font-medium">辅助模型</h3>
        <p className="text-xs text-neutral-500">
          非视觉主模型收到图片时，可按需调用辅助识图模型；视觉主模型仍直接读取图片。
        </p>
      </div>
      <PaperFrame className="wc-paper-frame-soft">
        <div className="wc-paper-card wc-paper-sand wc-paper-shape-b wc-paper-angle-soft-right wc-paper-pad">
          <div className="text-[11px] text-neutral-600">
            <span className="mb-1 block">辅助识图模型</span>
            <SelectMenu
              value={visionModelId}
              options={[
                { value: '', label: '不启用' },
                ...props.settings.visionModels.map((model) => ({
                  value: model.id,
                  label: model.displayName,
                })),
              ]}
              onValueChange={(value) => { setVisionModelId(value); setSaved(false) }}
              ariaLabel="辅助识图模型"
              disabled={props.disabled}
              className="w-full"
            />
          </div>
          {props.settings.visionModels.length === 0 && (
            <p className="mt-2 text-[11px] text-amber-700">
              请先配置至少一个带“图片”能力的模型连接。
            </p>
          )}
          <SaveRow disabled={props.disabled} saved={saved} onSave={submit} />
        </div>
      </PaperFrame>
    </section>
  )
}

export function ConsensusModelsEditor(props: {
  settings: ConsensusModelsSettingsItem
  disabled: boolean
  onSave: (request: SaveConsensusModelSettingsRequest) => Promise<boolean>
}) {
  const [agentBModelId, setAgentBModelId] = useState(props.settings.agentBModelId ?? '')
  const [agentCModelId, setAgentCModelId] = useState(props.settings.agentCModelId ?? '')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    setAgentBModelId(props.settings.agentBModelId ?? '')
    setAgentCModelId(props.settings.agentCModelId ?? '')
  }, [props.settings.agentBModelId, props.settings.agentCModelId])

  const options = [
    { value: '', label: '未选择' },
    ...props.settings.models.map((model) => ({ value: model.id, label: model.displayName })),
  ]
  const submit = async () => {
    setSaved(false)
    if (await props.onSave({
      agentBModelId: agentBModelId || null,
      agentCModelId: agentCModelId || null,
    })) setSaved(true)
  }

  return (
    <section className="wc-paper-section">
      <div>
        <h3 className="text-sm font-medium">协商评审员</h3>
        <p className="text-xs text-neutral-500">
          Main 始终使用当前会话模型；B/C 复用模型连接中的凭据与端点，不再单独配置连接。
        </p>
      </div>
      <PaperFrame className="wc-paper-frame-soft">
        <div className="wc-paper-card wc-paper-blue wc-paper-shape-c wc-paper-pad">
          <div className="grid gap-4 md:grid-cols-2">
            <ModelSelector
              label="Agent B"
              value={agentBModelId}
              options={options}
              disabled={props.disabled}
              onValueChange={(value) => { setAgentBModelId(value); setSaved(false) }}
            />
            <ModelSelector
              label="Agent C"
              value={agentCModelId}
              options={options}
              disabled={props.disabled}
              onValueChange={(value) => { setAgentCModelId(value); setSaved(false) }}
            />
          </div>
          {props.settings.models.length === 0 && (
            <p className="mt-2 text-[11px] text-amber-700">
              请先在“模型连接”中配置至少一个可用模型。
            </p>
          )}
          <SaveRow disabled={props.disabled} saved={saved} onSave={submit} />
        </div>
      </PaperFrame>
    </section>
  )
}

interface ModelOption {
  value: string
  label: string
}

function ModelSelector(props: {
  label: string
  value: string
  options: ModelOption[]
  disabled: boolean
  onValueChange: (value: string) => void
}) {
  return (
    <div className="text-[11px] text-neutral-600">
      <span className="mb-1 block">{props.label}</span>
      <SelectMenu
        value={props.value}
        options={props.options}
        onValueChange={props.onValueChange}
        ariaLabel={`${props.label} 模型`}
        disabled={props.disabled}
        className="w-full"
      />
    </div>
  )
}

function SaveRow(props: {
  disabled: boolean
  saved: boolean
  onSave: () => Promise<void>
}) {
  return (
    <div className="mt-3 flex items-center gap-2">
      <button
        className="wc-focus-ring rounded-xl bg-[var(--wc-ink)] px-3 py-1.5 text-xs text-white disabled:opacity-40"
        onClick={() => void props.onSave()}
        disabled={props.disabled}
      >
        保存
      </button>
      {props.saved && <span className="text-[11px] text-[var(--wc-sage-ink)]">已保存</span>}
    </div>
  )
}
