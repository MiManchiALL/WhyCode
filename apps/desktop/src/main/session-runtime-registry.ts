import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import type { UserMessageReservation } from './user-message-routing.ts'

export const SESSION_RUNTIME_IDLE_UNLOAD_MS = 30 * 60 * 1000

export interface SessionRuntimeRegistryOptions {
  maxConcurrentRuns?: number
  idleUnloadMs?: number
  onDisposeError?: (error: unknown) => void
  onRemoved?: (runtime: DesktopSessionRuntime) => void | Promise<void>
}

/**
 * 对话选择与对话执行解耦：切换只改变 selected，运行中的其它 runtime 继续存活。
 * 非选中且空闲的 runtime 保留一段空闲期，避免短时间切换时反复重建 AgentSession
 * 和 MCP 连接；运行中的 runtime 则从任务结束时开始计算。重新选中会取消卸载。
 */
export class SessionRuntimeRegistry {
  private readonly runtimes = new Map<string, DesktopSessionRuntime>()
  private readonly unloadTimers = new Map<string, NodeJS.Timeout>()
  private readonly maxConcurrentRuns: number
  private readonly idleUnloadMs: number
  private readonly onDisposeError: (error: unknown) => void
  private readonly onRemoved: (runtime: DesktopSessionRuntime) => void | Promise<void>
  private selectedRuntimeId: string | null = null

  constructor(options: SessionRuntimeRegistryOptions = {}) {
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 4
    this.idleUnloadMs = options.idleUnloadMs ?? SESSION_RUNTIME_IDLE_UNLOAD_MS
    this.onDisposeError = options.onDisposeError ?? (() => {})
    this.onRemoved = options.onRemoved ?? (() => {})
  }

  get selected(): DesktopSessionRuntime | null {
    return this.selectedRuntimeId
      ? this.runtimes.get(this.selectedRuntimeId) ?? null
      : null
  }

  get selectedId(): string | null {
    return this.selectedRuntimeId
  }

  all(): DesktopSessionRuntime[] {
    return [...this.runtimes.values()]
  }

  get(runtimeId: string): DesktopSessionRuntime | null {
    return this.runtimes.get(runtimeId) ?? null
  }

  findBySessionId(sessionId: string): DesktopSessionRuntime | null {
    return this.all().find((runtime) => runtime.sessionId === sessionId) ?? null
  }

  add(runtime: DesktopSessionRuntime): void {
    if (runtime.isDisposed) throw new Error('不能登记已释放的会话运行时')
    const existing = this.runtimes.get(runtime.runtimeId)
    if (existing && existing !== runtime) throw new Error('会话运行时 ID 重复')
    this.runtimes.set(runtime.runtimeId, runtime)
  }

  select(runtime: DesktopSessionRuntime): DesktopSessionRuntime | null {
    this.add(runtime)
    const previous = this.selected
    this.clearUnload(runtime.runtimeId)
    runtime.lastSelectedAt = Date.now()
    this.selectedRuntimeId = runtime.runtimeId
    if (previous && previous !== runtime) this.scheduleIdleUnload(previous)
    return previous
  }

  /**
   * 容量判断与占位必须在同一同步临界段完成；否则多个 IPC 同时从 idle 启动时
   * 都可能先通过检查，再一起越过并发上限。
   */
  reserveWorkStart(runtime: DesktopSessionRuntime): UserMessageReservation | null {
    if (!runtime.busy) {
      const active = this.all().filter((candidate) => candidate.busy).length
      if (active >= this.maxConcurrentRuns) return null
    }
    return runtime.routingGate.reserve()
  }

  anyBusy(): boolean {
    return this.all().some((runtime) => runtime.busy)
  }

  runtimeBecameIdle(runtime: DesktopSessionRuntime): void {
    if (runtime !== this.selected) this.scheduleIdleUnload(runtime)
  }

  async remove(runtime: DesktopSessionRuntime): Promise<void> {
    if (runtime.busy) throw new Error('运行中的会话不能移除')
    this.clearUnload(runtime.runtimeId)
    if (this.runtimes.get(runtime.runtimeId) === runtime) {
      this.runtimes.delete(runtime.runtimeId)
    }
    if (this.selectedRuntimeId === runtime.runtimeId) this.selectedRuntimeId = null
    await runtime.dispose().catch((error) => this.reportDisposeError(error))
    await this.reportRemoved(runtime)
  }

  async closeAll(): Promise<void> {
    for (const timer of this.unloadTimers.values()) clearTimeout(timer)
    this.unloadTimers.clear()
    const runtimes = this.all()
    await Promise.all(runtimes.map(async (runtime) => {
      if (runtime.busy) {
        await runtime.abort().catch((error) => this.reportDisposeError(error))
        await runtime.waitUntilIdle().catch((error) => this.reportDisposeError(error))
      }
      await runtime.dispose().catch((error) => this.reportDisposeError(error))
      await this.reportRemoved(runtime)
    }))
    this.runtimes.clear()
    this.selectedRuntimeId = null
  }

  private scheduleIdleUnload(runtime: DesktopSessionRuntime): void {
    this.clearUnload(runtime.runtimeId)
    if (runtime.busy || this.idleUnloadMs < 0) return
    const timer = setTimeout(() => {
      this.unloadTimers.delete(runtime.runtimeId)
      if (runtime === this.selected || runtime.busy) return
      void this.remove(runtime).catch((error) => this.reportDisposeError(error))
    }, this.idleUnloadMs)
    timer.unref()
    this.unloadTimers.set(runtime.runtimeId, timer)
  }

  private clearUnload(runtimeId: string): void {
    const timer = this.unloadTimers.get(runtimeId)
    if (timer) clearTimeout(timer)
    this.unloadTimers.delete(runtimeId)
  }

  private reportDisposeError(error: unknown): void {
    try {
      this.onDisposeError(error)
    } catch {}
  }

  private async reportRemoved(runtime: DesktopSessionRuntime): Promise<void> {
    try {
      await this.onRemoved(runtime)
    } catch (error) {
      this.reportDisposeError(error)
    }
  }
}
