import type { RendererDiagnostic } from '../../shared/diagnostics.ts'

export function reportRendererError(kind: RendererDiagnostic['kind'], error: unknown, componentStack?: string | null): void {
  const report: RendererDiagnostic = {
    kind,
    message: (error instanceof Error ? error.message : typeof error === 'string' ? error : '抛出了非 Error 异常').slice(0, 16 * 1024),
    stack: error instanceof Error ? error.stack?.slice(0, 32 * 1024) : undefined,
    componentStack: componentStack?.slice(0, 16 * 1024),
  }
  // 关闭窗口时 IPC 可能已不可用；诊断上报失败不能递归触发另一个全局异常。
  try { window.whycode.reportRendererDiagnostic(report) } catch { /* Main/原生控制台仍持有独立的故障入口。 */ }
}

export function installRendererDiagnostics(): () => void {
  const onError = (event: ErrorEvent) => reportRendererError('error', event.error ?? event.message)
  const onRejection = (event: PromiseRejectionEvent) => reportRendererError('unhandled-rejection', event.reason)
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}

const onReactError = (error: unknown, info: { componentStack?: string | null }) => {
  reportRendererError('react-render', error, info.componentStack)
  console.error(error)
}

export const rendererErrorHandlers = { onUncaughtError: onReactError, onCaughtError: onReactError }
