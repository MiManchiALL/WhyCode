import { Minus, Plus } from 'lucide-react'
import { CONVERSATION_FONT_SIZE } from './conversation-font-size.ts'
import { SettingsPanel, SettingsRow, SettingsSection } from './settings-layout.tsx'
import { BrowserDataSettings } from './browser-data-settings.tsx'

export function GeneralSettings({ fontSize, onFontSizeChange }: {
  fontSize: number
  onFontSizeChange: (value: number) => void
}) {
  return <>
    <SettingsSection title="外观" description="调整会话内容的阅读大小，修改后即时预览。">
      <SettingsPanel padded={false}>
        <SettingsRow label="字号大小" description="仅影响会话内容的字号" className="wc-font-size-setting" divided={false}>
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
    <BrowserDataSettings />
  </>
}
