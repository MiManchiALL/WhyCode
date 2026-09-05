export const MAX_TERMINALS = 8
export const TERMINAL_SCROLLBACK = 1_000
export const TERMINAL_MAX_INPUT = 64 * 1024
export const TERMINAL_MAX_COLS = 500
export const TERMINAL_MAX_ROWS = 200

export interface TerminalInfo {
  id: string
  title: string
  cwd: string
  windowsBuild?: number
}

export type TerminalEvent =
  | { terminalId: string; type: 'data'; data: string }
  | { terminalId: string; type: 'exit'; exitCode: number }

export type TerminalControl = { terminalId: string } & (
  | { type: 'ready' }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ack'; length: number }
)
