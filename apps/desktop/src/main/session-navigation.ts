import type { RuntimeSnapshot, ResumeSessionResult } from '../shared/session.ts'
import type { DesktopSessionRuntime } from './desktop-session-runtime.ts'

interface SessionNavigationOptions {
  find: (sessionId: string) => DesktopSessionRuntime | null
  prepare: (sessionId: string) => Promise<void>
  snapshot: (runtime: DesktopSessionRuntime) => Promise<RuntimeSnapshot>
  commit: (runtime: DesktopSessionRuntime) => void
  settled: (runtime: DesktopSessionRuntime | null) => void
}

/** 冷加载单飞，等待目标只取最新点击；已加载的运行时不必等待冷加载。 */
export class SessionNavigation {
  private current: { sessionId: string } | null = null
  private preparing: Promise<void> | null = null
  private readonly options: SessionNavigationOptions

  constructor(options: SessionNavigationOptions) {
    this.options = options
  }

  get sessionId(): string | null {
    return this.current?.sessionId ?? null
  }

  async resume(sessionId: string): Promise<ResumeSessionResult> {
    const request = { sessionId }
    this.current = request
    let runtime: DesktopSessionRuntime | null = null
    try {
      while (this.current === request) {
        runtime = this.options.find(sessionId)
        if (runtime) break
        if (this.preparing) {
          // 另一个目标的失败不影响最新选择；同一目标会由原请求报告或重新打开。
          await this.preparing.catch(() => {})
        } else {
          const preparation = this.options.prepare(sessionId)
          this.preparing = preparation
          try {
            await preparation
          } finally {
            if (this.preparing === preparation) this.preparing = null
          }
        }
      }
      if (this.current !== request || !runtime) return superseded()
      const snapshot = await this.options.snapshot(runtime)
      if (this.current !== request) return superseded()
      // 快照成功后同步提交；旧请求既不能选择会话，也不能回滚新选择。
      this.options.commit(runtime)
      return { ok: true, snapshot: { ...snapshot, resumingSessionId: null } }
    } catch (error) {
      return {
        ok: false,
        error: `会话恢复失败：${error instanceof Error ? error.message : String(error)}`,
      }
    } finally {
      if (this.current === request) {
        this.current = null
        this.options.settled(runtime)
      }
    }
  }
}

function superseded(): ResumeSessionResult {
  return { ok: false, error: '已切换至其它会话' }
}
