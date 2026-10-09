import { Check, ChevronDown } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useRef, useState } from 'react'

export interface SelectMenuOption {
  value: string
  label: string
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
  const selectedLabel = options.find((option) => option.value === value)?.label ?? '请选择'
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
          <span className="min-w-0 truncate">{selectedLabel}</span>
          <ChevronDown size={13} className="shrink-0 text-[var(--wc-faint)]" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="wc-menu-content min-w-[var(--radix-dropdown-menu-trigger-width)] max-w-[min(30rem,calc(100vw-2rem))]"
          align={align}
          sideOffset={5}
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
          <div className="wc-scrollbar max-h-64 overflow-y-auto">
          <DropdownMenu.RadioGroup value={value} onValueChange={onValueChange}>
            {(searchable ? filtered.slice(0, 200) : filtered).map((option) => (
              <DropdownMenu.RadioItem
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="wc-menu-item min-w-0"
                title={option.label}
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  <DropdownMenu.ItemIndicator>
                    <Check size={14} />
                  </DropdownMenu.ItemIndicator>
                </span>
                <span className="min-w-0 truncate">{option.label}</span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {!filtered.length && <p className="px-2 py-3 text-xs text-[var(--wc-faint)]">没有匹配项</p>}
          {searchable && filtered.length > 200 && <p className="px-2 py-2 text-xs text-[var(--wc-faint)]">输入名称以查找更多结果</p>}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
