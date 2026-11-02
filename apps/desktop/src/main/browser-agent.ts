import { z } from 'zod'
import type { BrowserDriver } from '@whycode/core'
import { BrowserAutomation } from './browser-automation.ts'
import { executeBrowserScript, type BrowserOperation } from './browser-execution.ts'
import { BrowserPages } from './browser-pages.ts'
import type { BrowserGuests } from './browser-guests.ts'
import { captureBrowserPage } from './browser-capture.ts'
import { browserDisplayUrl } from '../shared/browser.ts'

export class BrowserAgent {
  readonly pages: BrowserPages
  private readonly automation = new Map<string, BrowserAutomation>()
  // 只记录上次报告过的 ID，用于跨调用报告异步出现的网页；页面事实仍由 BrowserPages 持有。
  private readonly reportedPages = new Map<string, Set<string>>()

  constructor(guests: BrowserGuests) { this.pages = new BrowserPages(guests) }

  forRuntime(runtimeId: string): BrowserDriver {
    return {
      execute: async (code, context) => {
        if (!context.turnId) throw new Error('Browser 只能在当前主会话 Turn 内执行')
        const turnId = context.turnId
        const previousPages = this.reportedPages.get(turnId) ?? new Set(this.pages.list(runtimeId).map(page => page.id))
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
            const guest = await this.pages.guest(turn, signal)
            return { ...this.pages.list(runtimeId).find(page => page.id === turn.surfaceId),
              url: browserDisplayUrl(guest.getURL()), title: guest.getTitle(), loading: guest.isLoading() }
          } },
          ...['navigate', 'snapshot', 'click', 'fill', 'type', 'press', 'scroll', 'evaluate', 'wait', 'screenshot', 'dialog'].map(name => ({
            name, run: async (input: unknown, signal: AbortSignal) => {
              const turn = connect()
              // 导航和弹窗响应无需等待主文档；网页读写仍须确认文档就绪。
              const guest = await this.pages.guest(turn, signal, name === 'navigate' || name === 'dialog')
              let automation = this.automation.get(turnId)
              if (automation?.guest !== guest) {
                automation?.close()
                automation = new BrowserAutomation(guest)
              }
              this.automation.set(turnId, automation)
              signal.throwIfAborted()
              if (name === 'dialog') return automation.dialog(input, signal)
              return automation.perform(async () => {
                switch (name) {
                  case 'navigate':
                    await this.pages.navigate(turn, z.object({ url: z.string() }).parse(input).url, signal)
                    return { url: browserDisplayUrl(guest.getURL()), loading: guest.isLoading() }
                  case 'snapshot': await automation.observe(signal); return automation.snapshot(input, signal)
                  case 'click': await automation.click(input, signal); break
                  case 'fill': await automation.fill(input, signal); break
                  case 'type': await automation.type(input, signal); break
                  case 'press': await automation.press(input, signal); break
                  case 'scroll': await automation.scroll(input, signal); break
                  case 'evaluate': return automation.evaluate(input, signal)
                  case 'wait': return automation.wait(input, signal)
                  case 'screenshot':
                    await automation.observe(signal)
                    return captureBrowserPage(guest, signal, await automation.viewport(signal))
                }
                return { completed: true }
              }, signal)
            },
          })),
        ]
        try {
          const result = await executeBrowserScript(code, operations, signal, context.onProgress)
          const pages = this.pages.list(runtimeId)
          const ids = new Set(pages.map(page => page.id))
          const state = { selectedPageId: pages.find(page => page.selected)?.id ?? null,
            newPageIds: [...ids].filter(id => !previousPages.has(id)), removedPageIds: [...previousPages].filter(id => !ids.has(id)) }
          this.reportedPages.set(turnId, ids)
          return { ...result, text: `${result.text}\n网页状态：${JSON.stringify(state)}` }
        }
        finally { controller.abort() }
      },
      finishTurn: async turnId => {
        try { this.automation.get(turnId)?.close() }
        finally { this.automation.delete(turnId); this.reportedPages.delete(turnId); await this.pages.finish(turnId) }
      },
    }
  }
}
