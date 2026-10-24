import { Check, ChevronDown } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useRef, useState } from 'react'

const SEARCH_RESULT_LIMIT = 200

export interface SelectMenuOption {
  value: string
  label: string
  detail?: string
  disabled?: boolean
}

interface SelectMenuProps {
  value: string
  options: readonly SelectMenuOption[]
  onValueChange: (value: string) => void
  ariaLabel: string
  disabled?: boolean
  align?: 'start' | 'center' | 'end'
  className?: string
  searchable?: boolean
}

export function SelectMenu({
  value,
  options,
  onValueChange,
  ariaLabel,
  disabled = false,
  align = 'start',
  className = '',
  searchable = false,
}: SelectMenuProps) {
  const [search, setSearch] = useState('')
  const searchInput = useRef<HTMLInputElement>(null)
  const filtered = options.filter(option => !searchable || option.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const selected = options.find((option) => option.value === value)
  const selectedLabel = selected?.label ?? '请选择'
  return (
    <DropdownMenu.Root onOpenChange={open => { if (!open) setSearch('') }}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={`wc-select-trigger wc-focus-ring flex h-8 min-w-0 items-center justify-between gap-2 px-2.5 text-[13px] ${className}`}
          disabled={disabled}
          aria-label={ariaLabel}
          title={selectedLabel}
        >
          <span className="min-w-0 flex-1 truncate text-left">{selectedLabel}</span>
          {selected?.detail && <span className="wc-select-detail">{selected.detail}</span>}
          <ChevronDown size={13} className="shrink-0 text-[var(--wc-faint)]" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={`wc-menu-content ${searchable ? 'wc-select-search-menu' : 'min-w-[var(--radix-dropdown-menu-trigger-width)] max-w-[min(30rem,calc(100vw-2rem))]'}`}
          data-density={searchable ? 'compact' : undefined}
          align={align}
          sideOffset={5}
          collisionPadding={8}
          onFocus={event => { if (searchable && event.target === event.currentTarget) { event.preventDefault(); searchInput.current?.focus() } }}
          onEscapeKeyDown={event => { if (event.isComposing) event.preventDefault() }}
        >
          {searchable && <input ref={searchInput} className="wc-settings-input mb-1 w-full" aria-label={`搜索${ariaLabel}`} placeholder="搜索…" value={search}
            onChange={event => setSearch(event.target.value)} onKeyDown={event => {
              if (event.nativeEvent.isComposing) { event.stopPropagation(); return }
              if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation()
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const items = event.currentTarget.closest('[role="menu"]')?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not([data-disabled])')
                items?.[event.key === 'ArrowDown' ? 0 : items.length - 1]?.focus()
              }
            }} />}
          <div className="wc-select-options wc-scrollbar min-h-0 max-h-64 overflow-y-auto" onKeyDown={event => {
            if (!searchable || event.nativeEvent.isComposing || event.key !== 'ArrowUp') return
            const first = event.currentTarget.querySelector('[role="menuitemradio"]:not([data-disabled])')
            if (event.target !== first) return
            event.preventDefault()
            event.stopPropagation()
            searchInput.current?.focus({ preventScroll: true })
          }}>
          <DropdownMenu.RadioGroup value={value} onValueChange={onValueChange}>
            {(searchable ? filtered.slice(0, SEARCH_RESULT_LIMIT) : filtered).map((option) => (
              <DropdownMenu.RadioItem
                key={option.value}
                value={option.value}
                textValue={option.label}
                disabled={option.disabled}
                className="wc-menu-item min-w-0"
                title={option.label}
                onPointerMove={event => {
                  // 搜索时鼠标经过结果不应抢走输入焦点；点击仍可直接选择。
                  if (searchInput.current === document.activeElement) event.preventDefault()
                }}
                onPointerLeave={event => {
                  if (searchInput.current === document.activeElement) event.preventDefault()
                }}
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  <DropdownMenu.ItemIndicator>
                    <Check size={14} />
                  </DropdownMenu.ItemIndicator>
                </span>
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.detail && <span className="wc-select-detail">{option.detail}</span>}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {!filtered.length && <p className="px-2 py-3 text-xs text-[var(--wc-faint)]">没有匹配项</p>}
          {searchable && filtered.length > SEARCH_RESULT_LIMIT && <p className="px-2 py-2 text-xs text-[var(--wc-faint)]">共 {filtered.length} 项，显示前 {SEARCH_RESULT_LIMIT} 项；输入名称筛选</p>}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
