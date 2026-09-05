import { randomUUID } from 'node:crypto'
import { release } from 'node:os'
import { join } from 'node:path'
import type { IDisposable, IPty } from 'node-pty'
import {
  MAX_TERMINALS,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_INPUT,
  TERMINAL_MAX_ROWS,
  type TerminalEvent,
  type TerminalInfo,
} from '../shared/terminal.ts'

const OUTPUT_HIGH_WATER = 128 * 1024
const OUTPUT_LOW_WATER = 32 * 1024

interface TerminalOwner {
  windowId: number
  runtimeId: string
  sessionId: string | null
}

interface TerminalEntry extends TerminalOwner {
  info: TerminalInfo
  pty: TerminalPty | null
  subscriptions: IDisposable[]
  ready: boolean
  outstanding: number
  exitCode?: number
  publish: (event: TerminalEvent) => void
  closed: (terminalId: string) => void
}

export type TerminalPty = Pick<IPty,
  'cols' | 'rows' | 'write' | 'resize' | 'pause' | 'resume' | 'kill' | 'onData' | 'onExit'
>

/** 用户终端归宿主所有；Agent 空闲卸载和 Renderer 面板卸载不会终止 shell。 */
export class TerminalSessions {
  private readonly entries = new Map<string, TerminalEntry>()
  private readonly spawnPty: (cwd: string) => Promise<TerminalPty>

  constructor(spawnPty: (cwd: string) => Promise<TerminalPty> = spawnTerminalPty) {
    this.spawnPty = spawnPty
  }

  async create(
    owner: TerminalOwner,
    prepareDirectory: () => Promise<string>,
    publish: TerminalEntry['publish'],
    closed: TerminalEntry['closed'],
  ): Promise<TerminalInfo> {
    if (this.entries.size >= MAX_TERMINALS) {
      throw new Error(`最多同时打开 ${MAX_TERMINALS} 个终端，请先关闭不再使用的终端`)
    }
    let number = 1
    const titles = new Set([...this.entries.values()].map((entry) => entry.info.title))
    while (titles.has(`终端 ${number}`)) number++
    const info: TerminalInfo = { id: randomUUID(), title: `终端 ${number}`, cwd: '' }
    if (process.platform === 'win32') info.windowsBuild = Number(release().split('.')[2])
    const entry: TerminalEntry = {
      ...owner, info, publish, closed,
      pty: null, subscriptions: [], ready: false, outstanding: 0,
    }
    // 首个 await 前占位，关闭窗口和并发新建都能看到尚在启动的终端。
    this.entries.set(info.id, entry)
    try {
      info.cwd = await prepareDirectory()
      if (!this.has(entry)) throw new Error('终端启动已取消')
      const pty = await this.spawnPty(info.cwd)
      if (!this.has(entry)) {
        pty.kill()
        throw new Error('终端启动已取消')
      }
      entry.pty = pty
      pty.pause()
      entry.subscriptions.push(
        pty.onData((data) => {
          entry.outstanding += data.length
          if (entry.outstanding >= OUTPUT_HIGH_WATER) pty.pause()
          this.publish(entry, { terminalId: info.id, type: 'data', data })
        }),
        pty.onExit(({ exitCode }) => {
          entry.exitCode = exitCode
          entry.pty = null
          for (const subscription of entry.subscriptions.splice(0)) subscription.dispose()
          if (entry.ready) this.publish(entry, { terminalId: info.id, type: 'exit', exitCode })
        }),
      )
      return { ...info }
    } catch (error) {
      this.closeEntry(entry)
      throw error
    }
  }

  control(windowId: number, value: unknown): void {
    if (!value || typeof value !== 'object') return
    const control = value as Record<string, unknown>
    if (typeof control.terminalId !== 'string') return
    const entry = this.entries.get(control.terminalId)
    if (!entry || entry.windowId !== windowId) return
    const pty = entry.pty
    switch (control.type) {
      case 'ready':
        if (entry.ready) return
        entry.ready = true
        if (entry.exitCode !== undefined) {
          this.publish(entry, { terminalId: entry.info.id, type: 'exit', exitCode: entry.exitCode })
        } else pty?.resume()
        break
      case 'input':
        if (entry.ready && typeof control.data === 'string'
          && control.data.length <= TERMINAL_MAX_INPUT) pty?.write(control.data)
        break
      case 'resize':
        if (isDimension(control.cols, TERMINAL_MAX_COLS)
          && isDimension(control.rows, TERMINAL_MAX_ROWS)
          && pty && (pty.cols !== control.cols || pty.rows !== control.rows)) {
          pty.resize(control.cols, control.rows)
        }
        break
      case 'ack': {
        const length = control.length
        if (typeof length !== 'number' || !Number.isSafeInteger(length)
          || length <= 0 || length > entry.outstanding) return
        const previous = entry.outstanding
        entry.outstanding -= length
        if (entry.ready && previous > OUTPUT_LOW_WATER && entry.outstanding <= OUTPUT_LOW_WATER) {
          pty?.resume()
        }
        break
      }
    }
  }

  bindSession(runtimeId: string, sessionId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.runtimeId === runtimeId) entry.sessionId = sessionId
    }
  }

  close(windowId: number, terminalId: string): void {
    const entry = this.entries.get(terminalId)
    if (entry?.windowId === windowId) this.closeEntry(entry)
  }

  closeOwner(owner: Partial<TerminalOwner>): void {
    for (const entry of this.entries.values()) {
      if ((owner.windowId === undefined || owner.windowId === entry.windowId)
        && (owner.runtimeId === undefined || owner.runtimeId === entry.runtimeId)
        && (owner.sessionId === undefined || owner.sessionId === entry.sessionId)) {
        this.closeEntry(entry)
      }
    }
  }

  private has(entry: TerminalEntry): boolean {
    return this.entries.get(entry.info.id) === entry
  }

  private publish(entry: TerminalEntry, event: TerminalEvent): void {
    if (!this.has(entry)) return
    try {
      entry.publish(event)
    } catch {
      this.closeEntry(entry)
    }
  }

  private closeEntry(entry: TerminalEntry): void {
    if (!this.has(entry)) return
    this.entries.delete(entry.info.id)
    for (const subscription of entry.subscriptions.splice(0)) subscription.dispose()
    try {
      if (entry.pty) {
        entry.pty.resume()
        entry.pty.kill()
      }
    } finally {
      entry.pty = null
      entry.closed(entry.info.id)
    }
  }
}

function isDimension(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= maximum
}

async function spawnTerminalPty(cwd: string): Promise<IPty> {
  const { spawn } = await import('node-pty')
  const windows = process.platform === 'win32'
  const shell = windows
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : process.env.SHELL || '/bin/sh'
  return spawn(shell, windows ? ['-NoLogo', '-NoProfile'] : [], {
    cwd, cols: TERMINAL_MAX_COLS, rows: 24, name: 'xterm-256color',
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    useConpty: true,
    useConptyDll: true,
  })
}
