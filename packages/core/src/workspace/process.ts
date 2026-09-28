import type { ChildProcess } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { terminateProcessTree } from '../tools/run-command/process-termination.ts'

/** Both local and remote processes publish spawn/error/close, with close after output. */
export interface WorkspaceProcess extends EventEmitter {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  terminate(): Promise<boolean>
}

export async function stopWorkspaceProcess(child: ChildProcess | WorkspaceProcess): Promise<boolean> {
  return 'terminate' in child ? child.terminate() : terminateProcessTree(child)
}
