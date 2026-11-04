import { app, type BrowserWindow, type WebContents } from 'electron'
import { join } from 'node:path'
import { release } from 'node:os'
import { DiagnosticStore } from './store.ts'
import { RuntimeDiagnostics } from './runtime.ts'
import { observeDiagnosticContents, diagnosticUrl } from './contents.ts'

export class DesktopDiagnostics {
  readonly store = new DiagnosticStore({ directory: join(app.getPath('userData'), 'diagnostics'), environment: {
    appVersion: app.getVersion(), platform: process.platform, arch: process.arch, osRelease: release(),
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
  } })
  readonly runtime = new RuntimeDiagnostics(this.store)
  private closing = false
  private readonly isShuttingDown: () => boolean
  private readonly timer: ReturnType<typeof setInterval>
  private readonly onFatal = (error: Error, origin: string) => {
    this.store.fatal({ level: 'error', source: 'main', event: 'uncaught-exception', details: { error, origin } })
  }
  private readonly onChildGone = (_event: Electron.Event, details: Electron.Details) => {
    const event = { level: 'error' as const, source: 'process', event: 'child-process-gone', details: { ...details } }
    if (this.closing || this.isShuttingDown() || details.reason === 'clean-exit') this.store.log({ ...event, level: 'info' })
    else if (details.reason === 'killed') this.store.log({ ...event, level: 'warn' })
    else this.store.fault(event)
  }
  private readonly onCertificate = (_event: Electron.Event, contents: WebContents, url: string, error: string) => {
    this.store.log({ level: 'warn', source: 'browser', event: 'certificate-error', details: {
      webContentsId: contents.id, url: diagnosticUrl(url), error,
    } })
  }

  constructor(isShuttingDown: () => boolean = () => false) {
    this.isShuttingDown = isShuttingDown
    process.on('uncaughtExceptionMonitor', this.onFatal)
    app.on('child-process-gone', this.onChildGone)
    app.on('certificate-error', this.onCertificate)
    this.store.start()
    this.store.log({ level: 'info', source: 'app', event: 'startup' })
    this.timer = setInterval(() => this.sample(), 30_000)
    this.timer.unref()
  }

  sample(): void {
    if (this.closing || this.isShuttingDown() || !app.isReady()) return
    const metrics = app.getAppMetrics()
    this.store.log({ level: 'info', source: 'process', event: 'resource-sample', details: {
      processCount: metrics.length, mainMemoryBytes: process.memoryUsage(),
      processes: metrics.slice(0, 32).map(metric => ({ pid: metric.pid, type: metric.type,
        created: metric.creationTime, memoryKiB: metric.memory, cpuPercent: metric.cpu.percentCPUUsage })),
    } })
  }

  observe(contents: WebContents, source: 'renderer' | 'browser', pageId?: string): void {
    observeDiagnosticContents(this.store, contents, source, { pageId, isShuttingDown: () => this.closing || this.isShuttingDown() })
  }

  observeWindow(window: BrowserWindow): void {
    this.observe(window.webContents, 'renderer')
    const webContentsId = window.webContents.id
    window.on('unresponsive', () => this.store.fault({ level: 'error', source: 'renderer', event: 'unresponsive', details: { webContentsId } }))
    window.on('responsive', () => this.store.log({ level: 'info', source: 'renderer', event: 'responsive', details: { webContentsId } }))
  }

  async close(): Promise<void> {
    this.closing = true
    clearInterval(this.timer)
    app.off('child-process-gone', this.onChildGone)
    app.off('certificate-error', this.onCertificate)
    process.off('uncaughtExceptionMonitor', this.onFatal)
    await this.store.close()
  }
}
