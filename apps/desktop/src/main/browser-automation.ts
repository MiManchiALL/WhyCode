import type { WebContents } from 'electron'
import { z } from 'zod'
import { browserDisplayUrl } from '../shared/browser.ts'
import { browserInputFunction, focusedBrowserElement } from './browser-input.ts'
import { BROWSER_VIEWPORT } from '../shared/browser-agent.ts'

interface AxNode {
  ignored?: boolean; backendDOMNodeId?: number; role?: { value?: string }; name?: { value?: string }
  value?: { value?: unknown }; properties?: { name: string; value: { value?: unknown } }[]
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
      await this.guest.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { ...BROWSER_VIEWPORT, deviceScaleFactor: 1, mobile: false })
    }
    signal?.throwIfAborted()
  }

  async command(method: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<any> {
    await this.prepare(signal)
    return this.guest.debugger.sendCommand(method, args)
  }

  async snapshot(input: unknown, signal: AbortSignal): Promise<unknown> {
    const { offset, limit } = z.object({ offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100) }).parse(input ?? {})
    this.invalidate()
    await this.command('Runtime.releaseObjectGroup', { objectGroup: 'whycode-browser' }, signal)
    const { nodes } = await this.command('Accessibility.getFullAXTree', {}, signal) as { nodes: AxNode[] }
    const visible = nodes.filter(node => !node.ignored && node.role?.value !== 'InlineTextBox'
      && (node.role?.value !== 'generic' || node.name?.value || node.value?.value
        || node.properties?.some(property => property.name === 'focusable' && property.value.value === true)))
    let length = 0
    const items = []
    for (const node of visible.slice(offset, offset + limit)) {
      const ref = node.backendDOMNodeId ? `e${this.revision}-${this.refs.size + 1}` : undefined
      const state = Object.fromEntries((node.properties ?? [])
        .filter(property => ['disabled', 'checked', 'selected', 'expanded', 'required', 'focused', 'readonly'].includes(property.name))
        .map(property => [property.name, property.value.value]))
      const item = { ref, role: node.role?.value, name: node.name?.value?.slice(0, 1000),
        value: typeof node.value?.value === 'string' ? node.value.value.slice(0, 1000) : node.value?.value, ...state }
      length += JSON.stringify(item).length
      if (length > 40_000) break
      if (ref) this.refs.set(ref, node.backendDOMNodeId!)
      items.push(item)
    }
    return { url: browserDisplayUrl(this.guest.getURL()), title: this.guest.getTitle(), nodes: items,
      total: visible.length, ...(offset + items.length < visible.length ? { nextOffset: offset + items.length } : {}) }
  }

  async click(input: unknown, signal: AbortSignal): Promise<void> {
    if (!input || typeof input !== 'object' || !('ref' in input)) {
      const { x, y } = z.object({ x: z.number().min(0).max(1279), y: z.number().min(0).max(799) }).parse(input)
      await this.clickAt(x, y, signal)
      return
    }
    const { ref } = refSchema.parse(input)
    const objectId = await this.resolve(ref, signal)
    await this.call(objectId, `function() {
      if (!this.isConnected || this.disabled) throw Error('元素不可用，请重新观察');
      this.scrollIntoView({block:'center', inline:'center', behavior:'instant'});
    }`, [], signal)
    signal.throwIfAborted()
    const { quads } = await this.command('DOM.getContentQuads', { objectId }, signal) as { quads: number[][] }
    const quad = quads.find(q => Math.abs((q[2]! - q[0]!) * (q[5]! - q[1]!)) > 1)
    if (!quad) throw new Error('元素不可见，请重新观察')
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4
    const clear = await this.call(objectId, `function(x,y) {
      const hit = this.getRootNode().elementFromPoint(x,y);
      return !!hit && (hit === this || this.contains(hit));
    }`, [x, y], signal)
    if (!clear) throw new Error('元素被遮挡，尚未点击；请重新观察页面')
    signal.throwIfAborted()
    await this.clickAt(x, y, signal)
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
        if (await this.call(objectId, 'function(){return this.isConnected && this.getClientRects().length > 0}', [], signal)) return { visible: true }
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
    const { object } = await this.command('DOM.resolveNode', { backendNodeId, objectGroup: 'whycode-browser' }, signal)
    if (!object?.objectId) throw new Error('元素已移除，请重新观察')
    // AX 的 StaticText 可以指向 Text 节点；交互应落在其真实所属元素上。
    if (object.className === 'Text') {
      const { result } = await this.command('Runtime.callFunctionOn', { objectId: object.objectId,
        functionDeclaration: 'function(){return this.parentElement}', objectGroup: 'whycode-browser' }, signal)
      if (!result?.objectId) throw new Error('元素已移除，请重新观察')
      return result.objectId
    }
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
