import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_INPUT,
  TERMINAL_MAX_ROWS,
  TERMINAL_SCROLLBACK,
  type TerminalInfo,
} from '../../shared/terminal.ts'

interface TerminalView {
  terminal: Terminal
  element: HTMLDivElement
  fit: FitAddon
}

const views = new Map<string, TerminalView>()
let unsubscribe: (() => void) | undefined

function createView(info: TerminalInfo, host: HTMLDivElement): TerminalView {
  const style = getComputedStyle(document.documentElement)
  const terminal = new Terminal({
    fontFamily: style.getPropertyValue('--wc-font-family-code'),
    fontSize: 13,
    lineHeight: 1.25,
    minimumContrastRatio: 4.5,
    scrollback: TERMINAL_SCROLLBACK,
    cursorBlink: false,
    theme: {
      background: style.getPropertyValue('--wc-surface').trim(),
      foreground: style.getPropertyValue('--wc-ink').trim(),
      cursor: style.getPropertyValue('--wc-ink').trim(),
      selectionBackground: style.getPropertyValue('--wc-blue').trim(),
    },
    ...(info.windowsBuild !== undefined
      ? { windowsPty: { backend: 'conpty' as const, buildNumber: info.windowsBuild } }
      : {}),
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  const element = document.createElement('div')
  element.className = 'h-full min-h-0 w-full min-w-0'
  host.append(element)
  terminal.open(element)
  terminal.textarea?.setAttribute('aria-label', `${info.title}输入`)
  terminal.onData((data) => {
    for (let start = 0; start < data.length;) {
      let end = Math.min(data.length, start + TERMINAL_MAX_INPUT)
      if (end < data.length && /[\uD800-\uDBFF]/u.test(data.charAt(end - 1))) end--
      window.whycode.controlTerminal({
        terminalId: info.id, type: 'input', data: data.slice(start, end),
      })
      start = end
    }
  })
  terminal.onResize(({ cols, rows }) =>
    window.whycode.controlTerminal({ terminalId: info.id, type: 'resize', cols, rows }))
  terminal.attachCustomKeyEventHandler((event) => !(event.ctrlKey
    && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'c' && terminal.hasSelection()))
  const view = { terminal, element, fit }
  views.set(info.id, view)
  unsubscribe ??= window.whycode.onTerminalEvent((event) => {
    const target = views.get(event.terminalId)?.terminal
    if (!target) return
    if (event.type === 'data') {
      target.write(event.data, () => {
        if (views.has(event.terminalId)) window.whycode.controlTerminal({
          terminalId: event.terminalId, type: 'ack', length: event.data.length,
        })
      })
    } else {
      target.options.disableStdin = true
      target.write(`\r\n\x1b[0m[进程已退出，退出码 ${event.exitCode}]\r\n`)
    }
  })
  return view
}

/** 只挂载活动标签；移除 DOM 时保留有界终端屏幕，后台输出不经过 React。 */
export function attachTerminal(info: TerminalInfo, host: HTMLDivElement): () => void {
  const existing = views.get(info.id)
  const view = existing ?? createView(info, host)
  host.append(view.element)
  const fit = () => {
    if (host.clientWidth < 32 || host.clientHeight < 32) return
    const dimensions = view.fit.proposeDimensions()
    if (!dimensions) return
    view.terminal.resize(
      Math.min(TERMINAL_MAX_COLS, Math.max(2, dimensions.cols)),
      Math.min(TERMINAL_MAX_ROWS, Math.max(2, dimensions.rows)),
    )
  }
  fit()
  if (!existing) window.whycode.controlTerminal({ terminalId: info.id, type: 'ready' })
  view.terminal.focus()
  let frame = 0
  const observer = new ResizeObserver(() => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; fit() })
  })
  observer.observe(host)
  return () => {
    observer.disconnect()
    cancelAnimationFrame(frame)
    view.terminal.blur()
    view.element.remove()
  }
}

export function disposeTerminalView(terminalId: string): void {
  const view = views.get(terminalId)
  if (!view) return
  views.delete(terminalId)
  view.terminal.dispose()
  view.element.remove()
  if (!views.size) {
    unsubscribe?.()
    unsubscribe = undefined
  }
}
