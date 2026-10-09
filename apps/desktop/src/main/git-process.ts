import { spawn } from 'node:child_process'
import { stopWorkspaceProcess, type WorkspaceIO } from '@whycode/core'
import { quoteShell } from './ssh/provision.ts'

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_OUTPUT_LIMIT = 1024 * 1024

export interface GitCommandResult {
  code: number | null
  stdout: string
  stderr: string
  outputTruncated: boolean
  timedOut: boolean
}

export interface GitCommandOptions {
  timeoutMs?: number
  outputLimit?: number
  readOnly?: boolean
  io?: WorkspaceIO
  encoding?: 'utf8' | 'base64'
}

export function runGit(
  workingDirectory: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT
  const environment = {
    GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1', LC_ALL: 'C',
    ...(options.readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
  }
  const child = options.io?.spawn
    ? options.io.spawn(`env ${Object.entries(environment).map(([key, value]) => `${key}=${value}`).join(' ')} git ${args.map(quoteShell).join(' ')}`, workingDirectory)
    : spawn('git', ['-C', workingDirectory, ...args], {
      detached: process.platform !== 'win32',
      env: { ...process.env, ...environment },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  if ('terminate' in child) child.once('spawn', () => child.stdin.end())

  return new Promise((resolve, reject) => {
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let outputTruncated = false
    let timedOut = false
    let settled = false

    const append = (target: Buffer[], chunk: Buffer, currentBytes: number): number => {
      const remaining = outputLimit - currentBytes
      if (remaining <= 0) {
        outputTruncated = true
        return currentBytes
      }
      const accepted = chunk.subarray(0, remaining)
      target.push(accepted)
      if (accepted.length < chunk.length) outputTruncated = true
      return currentBytes + accepted.length
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = append(stderr, chunk, stderrBytes)
    })

    const timer = setTimeout(() => {
      timedOut = true
      void stopWorkspaceProcess(child).catch(() => undefined)
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    timer.unref()

    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(
        'code' in error && error.code === 'ENOENT'
          ? '未找到 Git，请先安装 Git 并确保 git 命令在 PATH 中'
          : `Git 进程启动失败：${error.message}`,
      ))
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString(options.encoding ?? 'utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        outputTruncated,
        timedOut,
      })
    })
  })
}

export function requireGitSuccess(result: GitCommandResult, action: string): string {
  if (result.timedOut) throw new Error(`${action}超时`)
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `退出码 ${result.code ?? '未知'}`
    throw new Error(`${action}失败：${detail}`)
  }
  return result.stdout
}
