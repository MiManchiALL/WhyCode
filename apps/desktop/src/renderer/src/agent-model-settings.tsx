import { useEffect, useState } from 'react'
import type {
  AuxiliaryModelsSettingsItem,
  ConsensusModelsSettingsItem,
  SaveAuxiliaryModelSettingsRequest,
  SaveConsensusModelSettingsRequest,
} from '../../shared/settings.ts'
import { SelectMenu } from './select-menu.tsx'
import {
  SettingsButton,
  SettingsPanel,
  SettingsSection,
} from './settings-layout.tsx'

export function AuxiliaryModelsEditor(props: {
  settings: AuxiliaryModelsSettingsItem
  disabled: boolean
  onSave: (request: SaveAuxiliaryModelSettingsRequest) => Promise<boolean>
}) {
  const [visionModelId, setVisionModelId] = useState(props.settings.visionModelId ?? '')
  const [subagentModelId, setSubagentModelId] = useState(
    props.settings.subagentModelId ?? '',
  )
  const [visionSaved, setVisionSaved] = useState(false)
  const [subagentSaved, setSubagentSaved] = useState(false)
  useEffect(() => {
    setVisionModelId(props.settings.visionModelId ?? '')
  }, [props.settings.visionModelId])
  useEffect(() => {
    setSubagentModelId(props.settings.subagentModelId ?? '')
  }, [props.settings.subagentModelId])

  const saveVisionModel = async () => {
    setVisionSaved(false)
    if (await props.onSave({
      visionModelId: visionModelId || null,
      subagentModelId: props.settings.subagentModelId,
    })) setVisionSaved(true)
  }
  const saveSubagentModel = async () => {
    setSubagentSaved(false)
    if (await props.onSave({
      visionModelId: props.settings.visionModelId,
      subagentModelId: subagentModelId || null,
    })) setSubagentSaved(true)
  }

  return (
    <>
      <SettingsSection
        title="视觉辅助模型"
        description="非视觉主模型收到图片时按需调用；视觉主模型仍直接读取图片。"
      >
        <SettingsPanel>
          <div className="wc-type-caption text-neutral-600">
            <span className="mb-1 block">视觉辅助模型</span>
            <SelectMenu
              value={visionModelId}
              options={[
                { value: '', label: '不启用' },
                ...props.settings.visionModels.map((model) => ({
                  value: model.id,
                  label: model.displayName,
                })),
              ]}
              onValueChange={(value) => { setVisionModelId(value); setVisionSaved(false) }}
              ariaLabel="视觉辅助模型"
              disabled={props.disabled}
              className="w-full"
            />
          </div>
          {props.settings.visionModels.length === 0 && (
            <p className="mt-2 wc-type-caption text-amber-700">
              请先配置至少一个带“图片”能力的模型连接。
            </p>
          )}
          <SaveRow
            disabled={props.disabled}
            saved={visionSaved}
            onSave={saveVisionModel}
          />
        </SettingsPanel>
      </SettingsSection>

      <SettingsSection
        title="子代理模型"
        description="默认继承当前会话模型，也可固定使用已配置的模型连接。"
      >
        <SettingsPanel>
          <div className="wc-type-caption text-neutral-600">
            <span className="mb-1 block">子代理模型</span>
            <SelectMenu
              value={subagentModelId}
              options={[
                { value: '', label: '主模型' },
                ...props.settings.subagentModels.map((model) => ({
                  value: model.id,
                  label: model.displayName,
                })),
              ]}
              onValueChange={(value) => { setSubagentModelId(value); setSubagentSaved(false) }}
              ariaLabel="子代理模型"
              disabled={props.disabled}
              className="w-full"
            />
          </div>
          <SaveRow
            disabled={props.disabled}
            saved={subagentSaved}
            onSave={saveSubagentModel}
          />
        </SettingsPanel>
      </SettingsSection>
    </>
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
    <SettingsSection
      title="协商评审员"
      description="Main 始终使用当前会话模型；B/C 复用模型连接中的凭据与端点，不再单独配置连接。"
    >
      <SettingsPanel>
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
          <p className="mt-2 wc-type-caption text-amber-700">
            请先在“模型连接”中配置至少一个可用模型。
          </p>
        )}
        <SaveRow disabled={props.disabled} saved={saved} onSave={submit} />
      </SettingsPanel>
    </SettingsSection>
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
    <div className="wc-type-caption text-neutral-600">
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
    <div className="mt-3 flex items-center justify-end gap-2">
      {props.saved && <span className="wc-type-caption text-[var(--wc-sage-ink)]">已保存</span>}
      <SettingsButton
        variant="primary"
        onClick={() => void props.onSave()}
        disabled={props.disabled}
      >
        保存
      </SettingsButton>
    </div>
  )
}
