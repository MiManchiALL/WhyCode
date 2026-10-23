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
      <header className="wc-settings-section-header">
        <div className="wc-settings-section-heading">
          <h2>{title}</h2>
          <p>{description}</p>
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
    <div className={`wc-settings-surface${padded ? ' wc-settings-panel' : ''}${className ? ` ${className}` : ''}`}>
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
    <div className={`wc-settings-row${divided ? ' border-t border-[var(--wc-line)]' : ''}${className ? ` ${className}` : ''}`}>
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
      className="wc-settings-switch wc-focus-ring"
      onClick={() => onCheckedChange(!checked)}
      disabled={disabled}
    >
      <span aria-hidden="true" />
    </button>
  )
}

type SettingsButtonVariant = 'primary' | 'secondary' | 'danger'

interface SettingsButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: SettingsButtonVariant
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
      data-variant={variant}
      className={`wc-settings-button wc-focus-ring${className ? ` ${className}` : ''}`}
    />
  )
}
