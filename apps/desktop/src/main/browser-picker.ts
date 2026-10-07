/// <reference lib="dom" />
import type { BrowserPickOptions } from '../shared/browser-reference.ts'

/** 函数完整运行于 guest 的隔离世界，不暴露 preload、Node 或宿主消息入口。 */
export function browserPicker(options: BrowserPickOptions | 'clear' | 'hide' | 'show'): Promise<unknown> | void {
  type PickerWindow = Window & { __whycodePicker?: { close: () => void; host: HTMLElement; last: Element | null } }
  const world = window as PickerWindow
  const previous = world.__whycodePicker
  if (options === 'hide' || options === 'show') {
    if (previous) previous.host.style.setProperty('visibility', options === 'hide' ? 'hidden' : 'visible', 'important')
    // 等下一次合成提交再截图，避免把上一次绘制的选取边框一起截入原图。
    if (options === 'hide') return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ width: innerWidth, height: innerHeight, scrollX, scrollY }))))
    return
  }
  const selectedSelector = typeof options !== 'string' && options.parent ? options.selected.at(-1)?.selector : undefined
  const parent = previous?.last?.parentElement ?? (selectedSelector ? document.querySelector(selectedSelector)?.parentElement : null)
  previous?.close()
  if (options === 'clear') return
  if (options.parent && !parent) return Promise.reject(new Error('此目标无法继续选择父元素'))
  return new Promise(resolve => {
    // 独立 SVG 文档的 createElement 不会创建 HTMLElement，明确指定覆盖层的 HTML 命名空间。
    const html = <K extends keyof HTMLElementTagNameMap>(tag: K) => document.createElementNS('http://www.w3.org/1999/xhtml', tag) as HTMLElementTagNameMap[K]
    const host = html('div')
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;'
    const shadow = host.attachShadow({ mode: 'closed' })
    const style = html('style')
    style.textContent = `
      *{box-sizing:border-box}.box{position:fixed;pointer-events:none;border:3px solid #1769ef;background:#1769ef12;
      box-shadow:0 0 0 1px white,0 0 0 2px #17448866;border-radius:3px}
      .selected{border:2px solid #1769ef;background:#1769ef09;box-shadow:0 0 0 1px white}
      .region{border-style:dashed;background:#1769ef18}
      .badge{position:absolute;top:2px;left:2px;background:#125bd5;color:white;font:600 12px/22px system-ui;
      padding:0 6px;min-width:22px;border-radius:5px;box-shadow:0 1px 4px #0003;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis}
      .frame{position:fixed;pointer-events:auto;background:transparent;cursor:crosshair}
    `
    shadow.append(style)
    const hover = html('div')
    hover.className = 'box'
    hover.hidden = true
    const label = html('span')
    label.className = 'badge'
    hover.append(label)
    shadow.append(hover)
    const selected = options.selected.map((target, index) => {
      const box = html('div')
      box.className = `box selected${target.kind === 'region' ? ' region' : ''}`
      const badge = html('span')
      badge.className = 'badge'; badge.textContent = String(index + 1); box.append(badge); shadow.append(box)
      return { box, rect: target.rect }
    })
    // 跨域 frame 内无法读取 DOM，用透明命中面提供明确的区域引用。
    const frames = Array.from(document.querySelectorAll('iframe,frame')).slice(0, 100).map(frame => {
      const cover = html('div'); cover.className = 'frame'; shadow.append(cover)
      return { frame, cover }
    })
    const root = document.documentElement
    const svgRoot = root instanceof SVGSVGElement ? root : null
    const foreign = svgRoot ? document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject') : null
    if (foreign) { foreign.style.pointerEvents = 'none'; foreign.style.overflow = 'visible'; foreign.append(host); root.append(foreign) }
    else root.append(host)
    let hovered: Element | null = null
    let down: { x: number; y: number } | null = null
    let dragging = false
    let finished = false
    let closed = false
    const listeners: (() => void)[] = []
    const listen = (type: string, callback: EventListener) => {
      window.addEventListener(type, callback, true)
      listeners.push(() => window.removeEventListener(type, callback, true))
    }
    const place = (box: HTMLElement, rect: { x: number; y: number; width: number; height: number }) => {
      const x = Math.max(0, rect.x), y = Math.max(0, rect.y)
      const width = Math.min(innerWidth, rect.x + rect.width) - x
      const height = Math.min(innerHeight, rect.y + rect.height) - y
      box.hidden = width <= 0 || height <= 0
      Object.assign(box.style, { left: `${x}px`, top: `${y}px`, width: `${Math.max(0, width)}px`, height: `${Math.max(0, height)}px` })
    }
    const draw = () => {
      if (foreign && svgRoot) {
        foreign.setAttribute('width', String(innerWidth)); foreign.setAttribute('height', String(innerHeight))
        const matrix = svgRoot.getScreenCTM()?.inverse()
        if (matrix) foreign.setAttribute('transform', `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`)
      }
      selected.forEach(({ box, rect }) => place(box, { ...rect, x: rect.x - scrollX, y: rect.y - scrollY }))
      frames.forEach(({ frame, cover }) => place(cover, frame.getBoundingClientRect()))
      if (hovered && !finished && !dragging) place(hover, hovered.getBoundingClientRect())
    }
    const close = () => {
      if (closed) return
      closed = true; listeners.forEach(remove => remove()); (foreign ?? host).remove()
      if (world.__whycodePicker?.host === host) delete world.__whycodePicker
      if (!finished) resolve(null)
    }
    world.__whycodePicker = { close, host, last: null }
    const hit = (x: number, y: number): Element | null => {
      ;(foreign ?? host).style.setProperty('display', 'none', 'important')
      let element = document.elementFromPoint(x, y)
      while (element?.shadowRoot) {
        const nested = element.shadowRoot.elementFromPoint(x, y)
        if (!nested || nested === element) break
        element = nested
      }
      ;(foreign ?? host).style.removeProperty('display')
      return element
    }
    const excerpt = (element: Element): Element => {
      let remaining = 120
      const copy = (node: Element, depth: number): Element => {
        const clone = node.cloneNode(false) as Element
        for (const attr of Array.from(clone.attributes)) if (!['id', 'class', 'role', 'aria-label', 'alt', 'title'].includes(attr.name)) clone.removeAttribute(attr.name)
        if (depth >= 6 || node.matches('script,style,input,textarea,select,[contenteditable]')) return clone
        for (const child of node.childNodes) {
          if (--remaining < 0) break
          if (child.nodeType === Node.TEXT_NODE) clone.append(document.createTextNode((child.textContent ?? '').slice(0, 500)))
          else if (child instanceof Element && !child.matches('script,style,input,textarea,select,[contenteditable]')) clone.append(copy(child, depth + 1))
        }
        return clone
      }
      return copy(element, 0)
    }
    const named = (element: Element) => {
      const tag = element.localName
      const name = element.getAttribute('aria-label') || element.getAttribute('alt') || excerpt(element).textContent || ''
      return `${tag}${name.trim() ? ` · ${name.trim().replace(/\s+/gu, ' ').slice(0, 120)}` : ''}`.slice(0, 160)
    }
    const point = (event: PointerEvent) => ({ x: Math.max(0, Math.min(innerWidth, event.clientX)), y: Math.max(0, Math.min(innerHeight, event.clientY)) })
    const selectionRect = (end: { x: number; y: number }) => ({
      x: Math.min(down!.x, end.x), y: Math.min(down!.y, end.y),
      width: Math.abs(down!.x - end.x), height: Math.abs(down!.y - end.y),
    })
    const selector = (element: Element) => {
      // Shadow DOM 内的选择器不能冒充顶层 document 的选择器。
      if (element.getRootNode() !== document) return undefined
      const parts: string[] = []
      let item: Element | null = element
      for (let depth = 0; item && depth < 8; depth++, item = item.parentElement) {
        if (item.id && document.querySelectorAll(`#${CSS.escape(item.id)}`).length === 1) {
          parts.unshift(`#${CSS.escape(item.id)}`); break
        }
        const siblings = item.parentElement ? Array.from(item.parentElement.children).filter(child => child.localName === item!.localName) : []
        parts.unshift(`${CSS.escape(item.localName)}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(item) + 1})` : ''}`)
      }
      const value = parts.join(' > ')
      if (value.length > 2000) return undefined
      const matches = document.querySelectorAll(value)
      return matches.length === 1 && matches[0] === element ? value : undefined
    }
    const finish = (element: Element | null, measured: { x: number; y: number; width: number; height: number }, keep: boolean) => {
      const rect = { x: measured.x, y: measured.y, width: measured.width, height: measured.height }
      if (finished || rect.width < 2 || rect.height < 2) return
      finished = true; down = null; dragging = false; hover.hidden = true
      world.__whycodePicker!.last = element
      const region = !element || ['iframe', 'frame', 'canvas'].includes(element.localName)
      const box = html('div'); box.className = `box selected${region ? ' region' : ''}`
      const badge = html('span'); badge.className = 'badge'; badge.textContent = String(options.selected.length + 1)
      box.append(badge); shadow.append(box)
      const marked = { ...rect, x: rect.x + scrollX, y: rect.y + scrollY }
      selected.push({ box, rect: marked })
      place(box, rect)
      const target: Record<string, unknown> = {
        kind: region ? 'region' : 'element', label: region ? '所选网页区域' : named(element!),
        rect: { ...rect, x: rect.x + scrollX, y: rect.y + scrollY },
        viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, zoom: 1 },
      }
      if (element && !region) {
        const sensitive = element.closest('input,textarea,select,[contenteditable="true"]')
        const clone = excerpt(element)
        const css = getComputedStyle(element)
        Object.assign(target, {
          label: sensitive ? element.localName : named(element), selector: selector(element),
          text: sensitive ? '' : (clone.textContent ?? '').trim().replace(/\s+/gu, ' ').slice(0, 2000),
          html: sensitive ? '' : clone.outerHTML.slice(0, 3000),
          styles: { color: css.color.slice(0, 100), background: css.backgroundColor.slice(0, 100), font: css.font.slice(0, 200), display: css.display.slice(0, 40) },
        })
      }
      resolve({ target, title: document.title.slice(0, 256), continuePicking: keep })
    }
    const stop = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation() }
    listen('pointermove', event => {
      if (finished || !event.isTrusted) return
      const e = event as PointerEvent, p = point(e)
      if (down && Math.hypot(p.x - down.x, p.y - down.y) >= 6) dragging = true
      if (dragging) { hover.className = 'box region'; label.textContent = '区域'; place(hover, selectionRect(p)); return }
      hovered = hit(p.x, p.y)
      if (hovered) { hover.className = 'box'; label.textContent = named(hovered); place(hover, hovered.getBoundingClientRect()) }
    })
    listen('pointerdown', event => {
      const e = event as PointerEvent
      if (!event.isTrusted || e.button !== 0) return
      stop(e)
      if (!finished) { down = point(e); hovered = hit(e.clientX, e.clientY); dragging = false; host.setPointerCapture(e.pointerId) }
    })
    listen('pointerup', event => {
      const e = event as PointerEvent
      if (!event.isTrusted || e.button !== 0) return
      stop(e)
      if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId)
      if (finished || !down) return
      if (dragging) finish(null, selectionRect(point(e)), e.shiftKey)
      else if (hovered) finish(hovered, hovered.getBoundingClientRect(), e.shiftKey)
    })
    for (const type of ['click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'dragstart']) listen(type, stop)
    listen('pointercancel', () => { down = null; dragging = false; hover.hidden = true })
    listen('keydown', event => {
      const e = event as KeyboardEvent
      if (e.isComposing || !e.isTrusted) return
      if (e.key === 'Escape') { stop(e); close() }
      else if (!finished && e.key === 'ArrowUp' && hovered?.parentElement) {
        stop(e); hovered = hovered.parentElement; label.textContent = named(hovered); draw()
      } else if (!finished && e.key === 'Enter' && hovered) { stop(e); finish(hovered, hovered.getBoundingClientRect(), e.shiftKey) }
    })
    listen('scroll', draw); listen('resize', draw); listen('pagehide', close)
    draw()
    if (options.parent && parent?.isConnected) finish(parent, parent.getBoundingClientRect(), false)
  })
}

export function browserPickerScript(options: BrowserPickOptions | 'clear' | 'hide' | 'show'): string {
  return `(${browserPicker.toString()})(${JSON.stringify(options)})`
}
