import { spawn } from 'node:child_process'
import { OfficeProcessingError } from '@whycode/core/office'
import { terminateProcessTree } from '@whycode/core'

const OUTPUT_MAX_BYTES = 32_000

export interface HiddenProcessResult {
  stdout: string
  stderr: string
}

export function runHiddenProcess(options: {
  command: string
  args: readonly string[]
  workingDirectory: string
  environment?: NodeJS.ProcessEnv
  abortSignal: AbortSignal
  timeoutMs: number
  onForcedTermination?: () => Promise<void>
}): Promise<HiddenProcessResult> {
  if (options.abortSignal.aborted) {
    return Promise.reject(new OfficeProcessingError('aborted', 'Office 渲染已取消'))
  }
  const child = spawn(options.command, options.args, {
    cwd: options.workingDirectory,
    detached: process.platform !== 'win32',
    env: options.environment ?? process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let forced: 'aborted' | 'timeout' | null = null
    let forcedCleanup: Promise<void> | null = null
    let settled = false

    const append = (chunks: Buffer[], chunk: Buffer, byteCount: number): number => {
      const accepted = chunk.subarray(0, Math.max(0, OUTPUT_MAX_BYTES - byteCount))
      if (accepted.length > 0) chunks.push(accepted)
      return byteCount + accepted.length
    }
    const forceStop = (reason: 'aborted' | 'timeout') => {
      if (settled || forced) return
      forced = reason
      forcedCleanup = Promise.allSettled([
        terminateProcessTree(child),
        Promise.resolve().then(() => options.onForcedTermination?.()),
      ]).then(() => undefined)
    }
    const onAbort = () => forceStop('aborted')
    const timer = setTimeout(() => forceStop('timeout'), options.timeoutMs)
    timer.unref()

    options.abortSignal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = append(stderr, chunk, stderrBytes)
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.abortSignal.removeEventListener('abort', onAbort)
      void (async () => {
        await forcedCleanup
        reject(new Error(`后台转换进程启动失败：${error.message}`, { cause: error }))
      })()
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.abortSignal.removeEventListener('abort', onAbort)
      void (async () => {
        await forcedCleanup
        if (forced === 'aborted') {
          reject(new OfficeProcessingError('aborted', 'Office 渲染已取消'))
          return
        }
        if (forced === 'timeout') {
          reject(new OfficeProcessingError('timeout', 'Office 后台转换超时'))
          return
        }
        const result = {
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        }
        if (code !== 0) {
          const detail = result.stderr.trim() || result.stdout.trim() || `退出码 ${code ?? '未知'}`
          reject(new Error(`后台转换进程失败：${detail}`))
          return
        }
        resolve(result)
      })()
    })
    if (options.abortSignal.aborted) onAbort()
  })
}
