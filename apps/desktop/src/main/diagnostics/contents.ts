import type { WebContents } from 'electron'
import type { DiagnosticStore } from './store.ts'
import { diagnosticText } from './format.ts'

export function diagnosticUrl(value: string): string {
  if (/^(data|blob):/i.test(value)) return `${value.slice(0, value.indexOf(':'))}:[omitted]`
  return diagnosticText(value, 4096)
}

export function observeDiagnosticContents(
  store: DiagnosticStore, contents: WebContents, source: 'renderer' | 'browser',
  options: { pageId?: string; isShuttingDown: () => boolean },
): void {
  const identity = { webContentsId: contents.id, pageId: options.pageId }
  let generation = 0
  const details = () => ({ ...identity, generation, url: diagnosticUrl(contents.getURL()), osPid: contents.getOSProcessId() })
  store.log({ level: 'info', source, event: 'created', details: identity })
  contents.on('did-start-navigation', event => {
    if (!event.isMainFrame) return
    if (!event.isSameDocument) generation++
    store.log({ level: 'info', source, event: 'navigation-started', details: { ...identity, generation, url: diagnosticUrl(event.url) } })
  })
  contents.on('did-finish-load', () => {
    store.log({ level: 'info', source, event: 'document-loaded', details: details() })
  })
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    store.log({ level: code === -3 ? 'info' : 'warn', source, event: 'load-failed', details: {
      ...identity, generation, code, description, url: diagnosticUrl(url), isMainFrame,
    } })
  })
  contents.on('preload-error', (_event, path, error) => {
    store.fault({ level: 'error', source, event: 'preload-failed', details: { ...identity, path, error } })
  })
  contents.on('render-process-gone', (_event, exit) => {
    const event = { level: 'error' as const, source, event: 'process-gone', details: { ...identity, generation, ...exit } }
    if (exit.reason === 'clean-exit' || options.isShuttingDown()) store.log({ ...event, level: 'info' })
    else store.fault(event)
  })
  // 网页控制台可能包含用户内容；只采集宿主主界面的错误，并统一限长、脱敏。
  if (source === 'renderer') contents.on('console-message', event => {
    if (event.level === 'error') store.log({ level: 'error', source, event: 'console-error', details: {
      ...identity, message: event.message, sourceId: event.sourceId, lineNumber: event.lineNumber,
    } })
  })
  contents.once('destroyed', () => store.log({ level: 'info', source, event: 'destroyed', details: identity }))
}
