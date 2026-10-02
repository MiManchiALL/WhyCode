import { spawn, type ChildProcess } from 'node:child_process'
import { dirname, delimiter } from 'node:path'
import { stopWorkspaceProcess, type WorkspaceProcess } from '@whycode/core'

export function waitDependencyProcess(child: WorkspaceProcess | ChildProcess, signal: AbortSignal, progress?: (message: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    let failure: Error | undefined
    const accept = (chunk: Buffer) => { const text = chunk.toString(); output = (output + text).slice(-16000); progress?.(text) }
    const abort = () => { failure = new Error(signal.reason?.name === 'TimeoutError' ? '工作区依赖准备超时' : '工作区依赖准备已取消'); void stopWorkspaceProcess(child).catch(() => undefined) }
    child.stdout?.on('data', accept); child.stderr?.on('data', accept)
    child.once('error', error => { failure = error })
    child.once('close', code => {
      signal.removeEventListener('abort', abort)
      child.stdout?.off('data', accept); child.stderr?.off('data', accept)
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`工作区依赖准备失败（${code}）：${output}`))
      else resolve(output)
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

export function runDependencyProcess(executable: string, args: string[], cwd: string, signal: AbortSignal, progress?: (message: string) => void): Promise<string> {
  signal.throwIfAborted()
  return waitDependencyProcess(spawn(executable, args, { cwd, windowsHide: true, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${dirname(executable)}${delimiter}${process.env.PATH ?? ''}` },
  }), signal, progress)
}
