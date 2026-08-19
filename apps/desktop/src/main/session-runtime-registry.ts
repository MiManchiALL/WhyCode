import type { PermissionMode } from '@whycode/core/permissions'

import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import type { UserMessageReservation } from './user-message-routing.ts'

export const SESSION_RUNTIME_IDLE_UNLOAD_MS = 30 * 60 * 1000
export const MAX_CONCURRENT_AGENT_RUNS = 8

export interface SessionRuntimeRegistryOptions {
  maxConcurrentRuns?: number
  idleUnloadMs?: number
  onDisposeError?: (error: unknown) => void
  onRemoved?: (runtime: DesktopSessionRuntime) => void | Promise<void>
}

/**
 * 对话选择与对话执行解耦：切换只改变 selected，运行中的其它 runtime 继续存活。
 * 已建立会话且非选中、空闲的 runtime 保留一段空闲期，避免短时间切换时反复重建
 * AgentSession 和 MCP 连接；运行中的 runtime 则从任务结束时开始计算。没有历史入口的
 * 草稿由选择快照提交边界立即释放，重新选中已建立会话则取消卸载。
 */
export class SessionRuntimeRegistry {
  private readonly runtimes = new Map<string, DesktopSessionRuntime>()
  private readonly unloadTimers = new Map<string, NodeJS.Timeout>()
  private readonly maxConcurrentRuns: number
  private readonly idleUnloadMs: number
  private readonly onDisposeError: (error: unknown) => void
  private readonly onRemoved: (runtime: DesktopSessionRuntime) => void | Promise<void>
  private readonly unreadCompletionSessionIds = new Set<string>()
  private selectedRuntimeId: string | null = null

  constructor(options: SessionRuntimeRegistryOptions = {}) {
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? MAX_CONCURRENT_AGENT_RUNS
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
    if (runtime.sessionId) this.unreadCompletionSessionIds.delete(runtime.sessionId)
    if (previous && previous !== runtime) this.scheduleIdleUnload(previous)
    return previous
  }

  markWorkFinished(runtime: DesktopSessionRuntime): void {
    if (runtime === this.selected || !runtime.sessionId) return
    this.unreadCompletionSessionIds.add(runtime.sessionId)
  }

  hasUnreadCompletion(sessionId: string): boolean {
    return this.unreadCompletionSessionIds.has(sessionId)
  }

  forgetSession(sessionId: string): void {
    this.unreadCompletionSessionIds.delete(sessionId)
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

  /** 权限档位是应用级偏好；已加载与后台运行的会话必须在同一同步边界更新。 */
  setPermissionModeForAll(mode: PermissionMode): void {
    for (const runtime of this.runtimes.values()) runtime.setPermissionMode(mode)
  }

  runtimeBecameIdle(runtime: DesktopSessionRuntime): void {
    if (runtime === this.selected) return
    if (!runtime.sessionId) {
      void this.removeUnselectedDraft(runtime)
        .catch((error) => this.reportDisposeError(error))
      return
    }
    this.scheduleIdleUnload(runtime)
  }

  /** 快照提交后释放没有历史入口的旧草稿；选择事务失败时调用方不会进入这里。 */
  async removeUnselectedDraft(runtime: DesktopSessionRuntime): Promise<boolean> {
    if (runtime === this.selected || runtime.sessionId || runtime.busy) return false
    await this.remove(runtime)
    return true
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
        await runtime.abort('shutdown').catch((error) => this.reportDisposeError(error))
        await runtime.waitUntilIdle().catch((error) => this.reportDisposeError(error))
      }
      await runtime.dispose().catch((error) => this.reportDisposeError(error))
      await this.reportRemoved(runtime)
    }))
    this.runtimes.clear()
    this.unreadCompletionSessionIds.clear()
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
