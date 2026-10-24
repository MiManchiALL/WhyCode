import { Minus, Plus } from 'lucide-react'
import { CONVERSATION_FONT_SIZE } from './conversation-font-size.ts'
import { SettingsButton, SettingsPanel, SettingsRow, SettingsSection, SettingsSwitch } from './settings-layout.tsx'
import { BrowserDataSettings } from './browser-data-settings.tsx'
import type { CompletionSoundSetting } from './use-completion-sound.ts'

export function GeneralSettings({ fontSize, onFontSizeChange, completionSound }: {
  fontSize: number
  onFontSizeChange: (value: number) => void
  completionSound: CompletionSoundSetting
}) {
  return <>
    <SettingsSection title="外观" description="调整会话内容的阅读大小，修改后即时预览。">
      <SettingsPanel padded={false}>
        <SettingsRow label="字号大小" description="仅影响会话内容的字号" className="wc-settings-inline-row" divided={false}>
          <div role="group" aria-label="会话字号" className="wc-font-size-control">
            <button type="button" className="wc-focus-ring" aria-label="减小字号"
              disabled={fontSize <= CONVERSATION_FONT_SIZE.min} onClick={() => onFontSizeChange(fontSize - 1)}>
              <Minus size={14} aria-hidden="true" />
            </button>
            <output aria-live="polite">{fontSize} <span className="text-[var(--wc-faint)]">px</span></output>
            <button type="button" className="wc-focus-ring" aria-label="增大字号"
              disabled={fontSize >= CONVERSATION_FONT_SIZE.max} onClick={() => onFontSizeChange(fontSize + 1)}>
              <Plus size={14} aria-hidden="true" />
            </button>
          </div>
        </SettingsRow>
      </SettingsPanel>
    </SettingsSection>
    <SettingsSection title="声音" description="按需开启任务完成提醒。">
      <SettingsPanel padded={false}>
        <SettingsRow label="任务完成提示音" description="会话正常完成时提示，后台会话也会播放" className="wc-settings-inline-row" divided={false}>
          <div className="flex items-center justify-end gap-3">
            <SettingsButton disabled={!completionSound.enabled} onClick={completionSound.preview}>试听</SettingsButton>
            <SettingsSwitch ariaLabel="任务完成提示音" checked={completionSound.enabled} onCheckedChange={completionSound.setEnabled} />
          </div>
        </SettingsRow>
      </SettingsPanel>
    </SettingsSection>
    <BrowserDataSettings />
  </>
}
