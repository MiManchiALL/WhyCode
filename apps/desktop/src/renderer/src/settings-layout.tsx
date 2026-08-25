import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface SettingsSectionProps {
  title: string
  description: string
  actions?: ReactNode
  children: ReactNode
}

export function SettingsSection({
  title,
  description,
  actions,
  children,
}: SettingsSectionProps) {
  return (
    <section className="wc-settings-section">
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[13.5px] font-medium leading-5 text-[var(--wc-ink)]">{title}</h2>
          <p className="mt-0.5 text-[12.5px] leading-5 text-[var(--wc-muted)]">{description}</p>
        </div>
        {actions}
      </header>
      {children}
    </section>
  )
}

export function SettingsPanel({
  children,
  className,
  padded = true,
}: {
  children: ReactNode
  className?: string
  padded?: boolean
}) {
  return (
    <div className={`wc-menu-surface${padded ? ' wc-settings-panel' : ''}${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  )
}

export function SettingsRow({
  label,
  description,
  children,
  className,
  divided = true,
}: {
  label: ReactNode
  description?: ReactNode
  children: ReactNode
  className?: string
  divided?: boolean
}) {
  return (
    <div className={`grid min-w-0 gap-2 px-4 py-3 sm:grid-cols-[minmax(0,0.8fr)_minmax(16rem,1.2fr)] sm:items-center${divided ? ' border-t border-[var(--wc-line)]' : ''}${className ? ` ${className}` : ''}`}>
      <div className="min-w-0">
        <div className="text-[13px] font-medium leading-5 text-[var(--wc-ink)]">{label}</div>
        {description && (
          <div className="mt-0.5 wc-type-caption text-[var(--wc-muted)]">{description}</div>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function SettingsActionRow({
  children,
  className,
  divided = true,
}: {
  children: ReactNode
  className?: string
  divided?: boolean
}) {
  return (
    <div className={`flex min-w-0 flex-wrap items-center justify-end gap-2 px-4 py-3${divided ? ' border-t border-[var(--wc-line)]' : ''}${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  )
}

export function SettingsSwitch({
  checked,
  disabled = false,
  onCheckedChange,
  ariaLabel,
}: {
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={`wc-focus-ring relative inline-flex h-6 w-10 shrink-0 rounded-full transition-colors disabled:cursor-default disabled:opacity-40 ${
        checked ? 'bg-[#329cff]' : 'bg-black/[0.11]'
      }`}
      onClick={() => onCheckedChange(!checked)}
      disabled={disabled}
    >
      <span
        aria-hidden="true"
        className={`absolute left-0 top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

type SettingsButtonVariant = 'primary' | 'secondary' | 'danger'

interface SettingsButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: SettingsButtonVariant
}

const SETTINGS_BUTTON_VARIANTS: Record<SettingsButtonVariant, string> = {
  primary: 'border-transparent bg-[var(--wc-ink)] text-white hover:bg-[#30322e]',
  secondary: 'border-[var(--wc-line)] bg-white text-[var(--wc-muted)] hover:border-[var(--wc-line-strong)] hover:text-[var(--wc-ink)]',
  danger: 'border-[#dec8bf] bg-[#f8efec] text-[var(--wc-danger)] hover:bg-[#f2e3de]',
}

export function SettingsButton({
  variant = 'secondary',
  className,
  type,
  ...props
}: SettingsButtonProps) {
  return (
    <button
      {...props}
      type={type ?? 'button'}
      className={`wc-focus-ring inline-flex min-h-8 items-center justify-center gap-1.5 rounded-xl border px-3 py-1.5 text-[13px] font-medium leading-5 transition-colors disabled:cursor-default disabled:opacity-40 ${SETTINGS_BUTTON_VARIANTS[variant]}${className ? ` ${className}` : ''}`}
    />
  )
}
