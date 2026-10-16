import type { WebContents } from 'electron'
import { z } from 'zod'
import { browserDisplayUrl } from '../shared/browser.ts'
import { browserInputFunction, focusedBrowserElement } from './browser-input.ts'
import { browserNodeGeometry, type BrowserNodeGeometry } from './browser-visibility.ts'

interface AxNode {
  ignored?: boolean; backendDOMNodeId?: number; role?: { value?: string }; name?: { value?: string }
  value?: { value?: unknown }; description?: { value?: string }; properties?: { name: string; value: { value?: unknown } }[]
}
const refSchema = z.object({ ref: z.string().max(80) })
const fillSchema = refSchema.extend({ value: z.string().max(100_000) })
const keyCodes: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35 }

/** 使用 Chromium 的可访问性树与输入协议；节点引用仅属于当前文档和最近一次观察。 */
export class BrowserAutomation {
  private readonly refs = new Map<string, number>()
  private revision = 0
  private readonly originalZoom: number
  private readonly invalidate = () => { this.revision++; this.refs.clear() }

  constructor(private readonly guest: WebContents) {
    this.originalZoom = guest.getZoomFactor()
    guest.on('did-navigate', this.invalidate)
    guest.on('did-navigate-in-page', this.invalidate)
    guest.debugger.on('detach', this.invalidate)
  }

  async prepare(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.guest.isDestroyed()) throw new Error('网页已关闭')
    if (this.guest.getZoomFactor() !== 1) this.guest.setZoomFactor(1)
    if (!this.guest.debugger.isAttached()) {
      this.guest.debugger.attach('1.3')
      // 只模拟网页内的焦点；隐藏页输入不激活宿主窗口或抢占用户的系统焦点。
      await this.guest.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      await this.guest.debugger.sendCommand('Page.enable')
      await this.guest.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true, cancel: true })
    }
    signal?.throwIfAborted()
  }

  async command(method: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<any> {
    await this.prepare(signal)
    return this.guest.debugger.sendCommand(method, args)
  }

  async perform<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    await this.prepare(signal)
    let fileChooser = false
    const observe = (_event: unknown, method: string) => { if (method === 'Page.fileChooserOpened') fileChooser = true }
    this.guest.debugger.on('message', observe)
    try {
      const result = await operation()
      // 输入确认早于 Chromium 的文件框通知；同一页面提交新帧后再结束操作观察。
      await this.evaluate({ expression: 'new Promise(resolve => requestAnimationFrame(() => resolve(null)))' }, signal)
      if (fileChooser) throw new Error('该操作打开了文件选择器，已取消选择。Browser 暂不支持上传文件；请重新观察并确认目标控件。')
      return result
    } finally { this.guest.debugger.removeListener('message', observe) }
  }

  async viewport(signal: AbortSignal): Promise<{ width: number; height: number }> {
    return await this.evaluate({ expression: '({width: innerWidth, height: innerHeight})' }, signal) as { width: number; height: number }
  }

  async snapshot(input: unknown, signal: AbortSignal): Promise<unknown> {
    const { offset, limit } = z.object({ offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100) }).parse(input ?? {})
    this.invalidate()
    await this.command('Runtime.releaseObjectGroup', { objectGroup: 'whycode-browser' }, signal)
    const { nodes } = await this.command('Accessibility.getFullAXTree', {}, signal) as { nodes: AxNode[] }
    const candidates = nodes.filter(node => node.backendDOMNodeId && !node.ignored && !['InlineTextBox', 'RootWebArea'].includes(node.role?.value ?? '')
      && (node.role?.value !== 'generic' || node.name?.value || node.value?.value
        || node.properties?.some(property => property.name === 'focusable' && property.value.value === true)))
    const visible: { node: AxNode; geometry: BrowserNodeGeometry }[] = []
    // 有界并发查询实际布局；AX 中离屏、被裁切或遮挡的节点不进入当前观察。
    for (let start = 0; start < candidates.length; start += 16) {
      signal.throwIfAborted()
      const batch = await Promise.all(candidates.slice(start, start + 16).map(async node => {
        try {
          const objectId = await this.resolveNode(node.backendDOMNodeId!, signal)
          const geometry = await this.call(objectId, browserNodeGeometry, [], signal) as BrowserNodeGeometry | null
          return geometry ? { node, geometry } : null
        } catch (error) {
          if (/No node with given id|Could not find node|元素已移除/.test(String(error))) return null
          throw error
        }
      }))
      for (const item of batch) if (item) visible.push(item)
    }
    let length = 0
    const items = []
    for (const { node, geometry } of visible.slice(offset, offset + limit)) {
      const ref = node.backendDOMNodeId ? `e${this.revision}-${this.refs.size + 1}` : undefined
      const state = Object.fromEntries((node.properties ?? [])
        .filter(property => ['disabled', 'checked', 'selected', 'expanded', 'required', 'focused', 'readonly'].includes(property.name))
        .map(property => [property.name, property.value.value]))
      const item = { ref, role: node.role?.value, name: node.name?.value?.slice(0, 1000),
        ...(node.description?.value ? { description: node.description.value.slice(0, 1000) } : {}),
        value: typeof node.value?.value === 'string' ? node.value.value.slice(0, 1000) : node.value?.value, ...state, ...geometry }
      length += JSON.stringify(item).length
      if (length > 40_000) break
      if (ref) this.refs.set(ref, node.backendDOMNodeId!)
      items.push(item)
    }
    return { url: browserDisplayUrl(this.guest.getURL()), title: this.guest.getTitle(), viewport: await this.viewport(signal), nodes: items,
      total: visible.length, ...(offset + items.length < visible.length ? { nextOffset: offset + items.length } : {}) }
  }

  async click(input: unknown, signal: AbortSignal): Promise<void> {
    if (!input || typeof input !== 'object' || !('ref' in input)) {
      const { x, y } = z.object({ x: z.number().min(0), y: z.number().min(0) }).parse(input)
      const viewport = await this.viewport(signal)
      if (x >= viewport.width || y >= viewport.height) throw new Error(`坐标超出当前网页视口 ${viewport.width}×${viewport.height}；请按最新截图定位`)
      await this.clickAt(x, y, signal)
      return
    }
    const { ref } = refSchema.parse(input)
    const objectId = await this.resolve(ref, signal)
    const geometry = await this.call(objectId, browserNodeGeometry, [true], signal) as BrowserNodeGeometry | null
    if (!geometry) throw new Error('元素不在可见视口内或被遮挡，尚未点击；请重新观察页面')
    signal.throwIfAborted()
    await this.clickAt(geometry.point.x, geometry.point.y, signal)
  }

  async fill(input: unknown, signal: AbortSignal): Promise<void> {
    const { ref, value } = fillSchema.parse(input)
    const objectId = await this.resolve(ref, signal)
    await this.call(objectId, browserInputFunction, [value, true], signal)
  }

  async type(input: unknown, signal: AbortSignal): Promise<unknown> {
    const { text } = z.object({ text: z.string().max(100_000) }).parse(input)
    return this.evaluate({ expression: `(${browserInputFunction}).call(${focusedBrowserElement}, ${JSON.stringify(text)}, false)` }, signal)
  }

  async press(input: unknown, signal: AbortSignal): Promise<void> {
    const { key } = z.object({ key: z.string().max(40) }).parse(input)
    const selectAll = key === 'Control+A'
    const code = selectAll ? 65 : keyCodes[key]
    if (!code) throw new Error('不支持此按键，请参照浏览器指引')
    const params = { key: selectAll ? 'a' : key, windowsVirtualKeyCode: code, modifiers: selectAll ? 2 : 0 }
    await this.command('Input.dispatchKeyEvent', { type: 'keyDown', ...params }, signal)
    await this.command('Input.dispatchKeyEvent', { type: 'keyUp', ...params }, signal)
  }

  async scroll(input: unknown, signal: AbortSignal): Promise<void> {
    const { x, y } = z.object({ x: z.number().min(-10000).max(10000).default(0), y: z.number().min(-10000).max(10000).default(600) }).parse(input ?? {})
    await this.evaluate({ expression: `window.scrollBy({left:${x},top:${y},behavior:'instant'}); null` }, signal)
  }

  async evaluate(input: unknown, signal: AbortSignal): Promise<unknown> {
    const { expression } = z.object({ expression: z.string().max(20_000) },
      { error: 'browser.evaluate 需要 {expression: "JavaScript 表达式"}，不能传入函数' }).parse(input)
    const { frameTree } = await this.command('Page.getFrameTree', {}, signal)
    const { executionContextId } = await this.command('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'whycode-browser' }, signal)
    const response = await this.command('Runtime.evaluate', { expression, contextId: executionContextId,
      returnByValue: true, awaitPromise: true, timeout: 10_000 }, signal)
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    const value = response.result?.value ?? null
    if (JSON.stringify(value).length > 60_000) throw new Error('网页结果过长，请缩小查询范围')
    return value
  }

  async wait(input: unknown, signal: AbortSignal): Promise<unknown> {
    const options = z.object({ ref: z.string().optional(), text: z.string().min(1).max(1000).optional(),
      timeoutMs: z.number().int().min(1).max(10_000).default(5000) }).refine(v => v.ref || v.text,
      'browser.wait 必须提供 ref 或 text；timeoutMs 是等待条件的期限，不是固定延时').parse(input)
    const deadline = Date.now() + options.timeoutMs
    do {
      signal.throwIfAborted()
      if (options.ref) {
        const objectId = await this.resolve(options.ref, signal)
        if (await this.call(objectId, browserNodeGeometry, [], signal)) return { visible: true }
      } else if (await this.evaluate({ expression: `document.body.innerText.includes(${JSON.stringify(options.text)})` }, signal)) return { found: true }
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    throw new Error('等待网页条件超时')
  }

  close(): void {
    if (this.guest.isDestroyed()) return
    this.guest.removeListener('did-navigate', this.invalidate)
    this.guest.removeListener('did-navigate-in-page', this.invalidate)
    this.guest.debugger.removeListener('detach', this.invalidate)
    if (this.guest.debugger.isAttached()) this.guest.debugger.detach()
    this.guest.setZoomFactor(this.originalZoom)
  }

  private async resolve(ref: string, signal: AbortSignal): Promise<string> {
    const backendNodeId = this.refs.get(ref)
    if (!backendNodeId) throw new Error('元素引用已失效，请先 browser.snapshot()')
    return this.resolveNode(backendNodeId, signal)
  }
  private async resolveNode(backendNodeId: number, signal: AbortSignal): Promise<string> {
    const { object } = await this.command('DOM.resolveNode', { backendNodeId, objectGroup: 'whycode-browser' }, signal)
    if (!object?.objectId) throw new Error('元素已移除，请重新观察')
    return object.objectId
  }
  private async clickAt(x: number, y: number, signal: AbortSignal): Promise<void> {
    await this.command('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, signal)
    await this.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, signal)
  }
  private async call(objectId: string, functionDeclaration: string, args: unknown[], signal: AbortSignal): Promise<any> {
    const response = await this.command('Runtime.callFunctionOn', { objectId, functionDeclaration,
      arguments: args.map(value => ({ value })), returnByValue: true }, signal)
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result?.value
  }
}
