import { ChevronDown, ChevronUp } from 'lucide-react'
import { CONVERSATION_FONT_SIZE } from './conversation-font-size.ts'
import { SettingsRow } from './settings-layout.tsx'

const ARROW_CLASS = 'wc-focus-ring flex h-3 w-[17px] items-center justify-center rounded-[3px] bg-white/75 text-[var(--wc-ink)] hover:bg-white disabled:cursor-default disabled:text-[var(--wc-faint)]'

export function GeneralSettings({ fontSize, onFontSizeChange }: {
  fontSize: number
  onFontSizeChange: (value: number) => void
}) {
  return <SettingsRow label={<span className="text-sm font-normal">字号大小</span>}
    description="仅影响会话内容的字号" className="wc-font-size-setting" divided={false}>
    <div className="flex items-center gap-2 text-sm">
      <div role="group" aria-label="会话字号" className="group relative flex h-9 w-[72px] items-center justify-center rounded-full bg-black/[0.035]">
        <output className="min-w-[18px] text-center tabular-nums" aria-live="polite">{fontSize}</output>
        <span className="absolute right-2 flex flex-col gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <button type="button" className={ARROW_CLASS} aria-label="增大字号"
            disabled={fontSize >= CONVERSATION_FONT_SIZE.max} onClick={() => onFontSizeChange(fontSize + 1)}>
            <ChevronUp size={9} aria-hidden="true" />
          </button>
          <button type="button" className={ARROW_CLASS} aria-label="减小字号"
            disabled={fontSize <= CONVERSATION_FONT_SIZE.min} onClick={() => onFontSizeChange(fontSize - 1)}>
            <ChevronDown size={9} aria-hidden="true" />
          </button>
        </span>
      </div>
      <span className="text-[var(--wc-muted)]">px</span>
    </div>
  </SettingsRow>
}
