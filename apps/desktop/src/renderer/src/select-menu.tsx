import { Check, ChevronDown } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'

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
}

export function SelectMenu({
  value,
  options,
  onValueChange,
  ariaLabel,
  disabled = false,
  align = 'start',
  className = '',
}: SelectMenuProps) {
  const selectedLabel = options.find((option) => option.value === value)?.label ?? '请选择'
  return (
    <DropdownMenu.Root>
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
        >
          <DropdownMenu.RadioGroup value={value} onValueChange={onValueChange}>
            {options.map((option) => (
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
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
