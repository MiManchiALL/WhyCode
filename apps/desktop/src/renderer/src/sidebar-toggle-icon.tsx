interface SidebarToggleIconProps {
  side: 'left' | 'right'
  size?: number
  className?: string
}

export function SidebarToggleIcon({
  side,
  size = 16,
  className,
}: SidebarToggleIconProps) {
  const dividerX = side === 'left' ? 8 : 16
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3.5" y="4" width="17" height="16" rx="3.25" />
      <path d={`M${dividerX} 8.25v7.5`} />
    </svg>
  )
}
