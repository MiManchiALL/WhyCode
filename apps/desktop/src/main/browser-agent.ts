import { z } from 'zod'
import type { BrowserDriver } from '@whycode/core'
import { BrowserAutomation } from './browser-automation.ts'
import { executeBrowserScript, type BrowserOperation } from './browser-execution.ts'
import { BrowserPages } from './browser-pages.ts'
import type { BrowserGuests } from './browser-guests.ts'
import { captureBrowserPage } from './browser-capture.ts'

export class BrowserAgent {
  readonly pages: BrowserPages
  private readonly automation = new Map<string, BrowserAutomation>()

  constructor(guests: BrowserGuests) { this.pages = new BrowserPages(guests) }

  forRuntime(runtimeId: string): BrowserDriver {
    return {
      execute: async (code, context) => {
        if (!context.turnId) throw new Error('Browser 只能在当前主会话 Turn 内执行')
        const turnId = context.turnId
        const controller = new AbortController()
        const signal = AbortSignal.any([context.abortSignal, controller.signal])
        let connected = false
        const connect = () => {
          const turn = this.pages.current(turnId)
          const abort = () => controller.abort(turn.abort.signal.reason)
          if (!connected) { turn.abort.signal.addEventListener('abort', abort, { once: true, signal }); connected = true }
          if (turn.abort.signal.aborted) abort()
          return turn
        }
        const operations: BrowserOperation[] = [
          { name: 'tabs', run: async () => this.pages.list(runtimeId) },
          { name: 'open', run: async (input, signal) => {
            const target = z.object({ id: z.string().optional(), url: z.string().optional() }).parse(input ?? {})
            const turn = this.pages.open(runtimeId, turnId, target)
            connect()
            await this.pages.guest(turn, signal)
            return this.pages.list(runtimeId).find(page => page.id === turn.surfaceId)
          } },
          ...['navigate', 'snapshot', 'click', 'fill', 'type', 'press', 'scroll', 'evaluate', 'wait', 'screenshot'].map(name => ({
            name, run: async (input: unknown, signal: AbortSignal) => {
              const turn = connect()
              const guest = await this.pages.guest(turn, signal)
              const automation = this.automation.get(turnId) ?? new BrowserAutomation(guest)
              this.automation.set(turnId, automation)
              signal.throwIfAborted()
              return automation.perform(async () => {
                switch (name) {
                  case 'navigate': await this.pages.navigate(turn, z.object({ url: z.string() }).parse(input).url, signal); return { url: guest.getURL() }
                  case 'snapshot': return automation.snapshot(input, signal)
                  case 'click': await automation.click(input, signal); break
                  case 'fill': await automation.fill(input, signal); break
                  case 'type': await automation.type(input, signal); break
                  case 'press': await automation.press(input, signal); break
                  case 'scroll': await automation.scroll(input, signal); break
                  case 'evaluate': return automation.evaluate(input, signal)
                  case 'wait': return automation.wait(input, signal)
                  case 'screenshot':
                    // 输入完成与画面提交不是同一时刻；等待浏览器提交新帧，避免截到上一次绘制。
                    await automation.evaluate({ expression: 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))' }, signal)
                    return captureBrowserPage(guest, signal, await automation.viewport(signal))
                }
                return { completed: true }
              }, signal)
            },
          })),
        ]
        try { return await executeBrowserScript(code, operations, signal, context.onProgress) }
        finally { controller.abort() }
      },
      finishTurn: async turnId => {
        try { this.automation.get(turnId)?.close() }
        finally { this.automation.delete(turnId); await this.pages.finish(turnId) }
      },
    }
  }
}
