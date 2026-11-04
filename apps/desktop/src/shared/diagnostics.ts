export const DIAGNOSTIC_LIMITS = {
  runtimeFileBytes: 16 * 1024 * 1024,
  runtimeFiles: 4,
  retentionDays: 14,
  reportBytes: 1024 * 1024,
  reports: 10,
} as const

export interface DiagnosticState {
  runtimeBytes: number
  reportBytes: number
  reportCount: number
  busy: 'clearing' | 'exporting' | null
  error: string | null
  droppedRecords: number
}

export interface RendererDiagnostic {
  kind: 'error' | 'unhandled-rejection' | 'react-render'
  message: string
  stack?: string
  componentStack?: string
}
