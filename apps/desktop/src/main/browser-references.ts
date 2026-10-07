import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import { z } from 'zod'
import { BROWSER_REFERENCE_MAX_TARGETS, browserTargetSchema, type BrowserReferenceSource } from '@whycode/core/browser-reference'
import { browserDisplayUrl } from '../shared/browser.ts'
import type { BrowserReferenceProjection, BrowserTargetCapture } from '../shared/browser-reference.ts'
import { browserPickerScript } from './browser-picker.ts'

const optionsSchema = z.object({ selected: z.array(browserTargetSchema).max(BROWSER_REFERENCE_MAX_TARGETS), parent: z.boolean().optional() })
const selectionSchema = optionsSchema.omit({ parent: true }).extend({ reveal: z.boolean().optional() })
const resultSchema = z.object({
  target: browserTargetSchema.omit({ capturedAt: true }),
  title: z.string().max(256), continuePicking: z.boolean(),
})
const WORLD = 1004
const cursor = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="m4 4 7.07 17 2.51-7.39L21 11.07z" fill="white" stroke="#1769ef" stroke-width="2" stroke-linejoin="round"/></svg>')}") 4 4, crosshair`

/** 每个 guest 只有一个选取请求；导航、关闭和新请求使所有迟到结果失效。 */
export class BrowserReferences {
  private pending: AbortController | null = null
  private revision = 0
  private cursorStyle: Promise<string> | null = null
  private readonly guest: WebContents
  private readonly fileSource: (url: string) => BrowserReferenceSource['page']['file']

  constructor(guest: WebContents, fileSource: (url: string) => BrowserReferenceSource['page']['file']) {
    this.guest = guest; this.fileSource = fileSource
    guest.on('did-start-navigation', event => { if (event.isMainFrame) this.cancel() })
    guest.on('render-process-gone', () => this.cancel())
    guest.once('destroyed', () => this.cancel())
  }

  cancel(): void {
    this.revision++
    this.pending?.abort(); this.pending = null
    const style = this.cursorStyle; this.cursorStyle = null
    if (style) void style.then(key => { if (!this.guest.isDestroyed()) return this.guest.removeInsertedCSS(key) }).catch(() => {})
    if (!this.guest.isDestroyed()) void this.execute('clear').catch(() => {})
  }

  get active(): boolean { return this.cursorStyle !== null }

  private enableCursor(): Promise<string> {
    // Electron 43 的按 key 移除只撤销 author 样式；引用光标必须能随退出完整清理。
    return this.cursorStyle ??= this.guest.insertCSS(`:root, :root * { cursor: ${cursor} !important; }`)
  }

  async display(input: unknown): Promise<BrowserReferenceProjection | null> {
    const options = selectionSchema.parse(input)
    this.pending?.abort(); this.pending = null
    const revision = ++this.revision
    await this.enableCursor()
    if (revision !== this.revision || this.guest.isDestroyed()) return null
    const result = await this.execute({ ...options, display: true })
    return revision === this.revision ? z.object({
      missing: z.array(z.string().uuid()).max(BROWSER_REFERENCE_MAX_TARGETS),
      anchor: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1),
        width: z.number().positive().max(1), height: z.number().positive().max(1) }).optional(),
    }).parse(result) : null
  }

  async pick(input: unknown): Promise<BrowserTargetCapture | null> {
    const options = optionsSchema.parse(input)
    if (options.parent && options.selected.at(-1)?.kind !== 'element') throw new Error('请先选择一个元素')
    this.pending?.abort()
    const revision = ++this.revision
    const pending = new AbortController()
    this.pending = pending
    const valid = () => this.revision === revision && !pending.signal.aborted && !this.guest.isDestroyed()
    let stop: () => void = () => {}
    try {
      await this.enableCursor()
      if (!valid()) return null
      const cancelled = new Promise<null>(resolve => {
        stop = () => resolve(null)
        pending.signal.addEventListener('abort', stop, { once: true })
      })
      const captureId = options.parent ? options.selected.at(-1)!.id : randomUUID()
      const raw = await Promise.race([this.execute({ ...options, captureId }), cancelled])
      if (!raw || !valid()) return null
      const result = resultSchema.parse(raw)
      const { viewport, rect } = result.target
      const paddingX = Math.max(96, Math.min(180, rect.width * 0.25))
      const paddingY = Math.max(96, Math.min(180, rect.height * 0.25))
      const left = Math.max(0, rect.x - viewport.scrollX - paddingX)
      const top = Math.max(0, rect.y - viewport.scrollY - paddingY)
      const right = Math.min(viewport.width, rect.x - viewport.scrollX + rect.width + paddingX)
      const bottom = Math.min(viewport.height, rect.y - viewport.scrollY + rect.height + paddingY)
      if (right - left < 2 || bottom - top < 2) throw new Error('目标已移出可见区域，请重新选择')
      const zoom = this.guest.getZoomFactor()
      const crop = { x: left + viewport.scrollX, y: top + viewport.scrollY, width: right - left, height: bottom - top }
      const layout = await Promise.race([this.execute('hide'), cancelled])
      if (!valid()) return null
      const current = browserTargetSchema.shape.viewport.omit({ zoom: true }).parse(layout)
      if (current.width !== viewport.width || current.height !== viewport.height
        || current.scrollX !== viewport.scrollX || current.scrollY !== viewport.scrollY) {
        throw new Error('选取时页面位置发生变化，请重新选择目标')
      }
      const shot = await Promise.race([this.guest.capturePage({
        x: Math.floor(left * zoom), y: Math.floor(top * zoom),
        width: Math.max(1, Math.floor(crop.width * zoom)), height: Math.max(1, Math.floor(crop.height * zoom)),
      }), cancelled])
      if (!shot || !valid()) return null
      if (shot.isEmpty()) throw new Error('此页面暂时无法截图，请重新选择')
      const size = shot.getSize()
      const scale = Math.min(1, 1200 / size.width, 1000 / size.height)
      const bytes = shot.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }).toJPEG(88)
      if (bytes.byteLength > 4 * 1024 * 1024) throw new Error('所选区域过大，请缩小后重试')
      const rawUrl = this.guest.getURL()
      const url = rawUrl.startsWith('data:') ? `${rawUrl.slice(0, rawUrl.indexOf(',') + 1)}[页面内容省略]` : browserDisplayUrl(rawUrl)
      return {
        target: { ...result.target, viewport: { ...viewport, zoom }, capturedAt: new Date().toISOString() },
        page: { url: url.slice(0, 8192), title: result.title, file: this.fileSource(rawUrl) },
        bytes, crop, continuePicking: result.continuePicking,
      }
    } catch (error) {
      if (!valid()) return null
      throw error
    } finally {
      pending.signal.removeEventListener('abort', stop)
      if (valid()) this.pending = null
    }
  }

  private execute(options: Parameters<typeof browserPickerScript>[0]): Promise<unknown> {
    return this.guest.executeJavaScriptInIsolatedWorld(WORLD, [{ code: browserPickerScript(options) }], true)
  }
}
