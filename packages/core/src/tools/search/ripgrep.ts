import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const SEARCH_TIMEOUT_MS = 20_000
const MAX_STDERR_CHARS = 4_000

export interface RipgrepLines {
  lines: string[]
  truncated: boolean
}

let ripgrepPathPromise: Promise<string | null> | null = null

/**
 * 只从 PATH 的绝对目录解析 rg，避免 Windows 在项目 cwd 中误命中同名可执行文件。
 * 找不到时返回 null，由调用方使用无依赖的 Node.js 回退实现。
 */
async function findRipgrepPath(): Promise<string | null> {
  const pathValue = Object.entries(process.env).find(
    ([key]) => key.toLowerCase() === 'path',
  )?.[1]
  if (!pathValue) return null

  const executable = process.platform === 'win32' ? 'rg.exe' : 'rg'
  for (const rawDir of pathValue.split(delimiter)) {
    const dir = rawDir.trim().replace(/^"|"$/g, '')
    if (!dir || !isAbsolute(dir)) continue
    const candidate = join(dir, executable)
    try {
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      return candidate
    } catch {
      // PATH 中不存在该候选，继续查找。
    }
  }
  return null
}

function getRipgrepPath(): Promise<string | null> {
  return (ripgrepPathPromise ??= findRipgrepPath())
}

function abortError(): Error {
  const error = new Error('搜索已被中止')
  error.name = 'AbortError'
  return error
}

/**
 * 执行 ripgrep 并按行流式截断，避免大仓库搜索先把全部 stdout 放进内存。
 * code=1 表示无匹配，仍属于成功；达到行数上限时主动结束 rg 并返回部分结果。
 */
export async function runRipgrepLines(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  maxLines: number,
): Promise<RipgrepLines | null> {
  const executable = await getRipgrepPath()
  if (!executable) return null
  if (signal.aborted) throw abortError()

  return new Promise<RipgrepLines>((resolve, reject) => {
    const child = spawn(executable, ['--no-config', ...args], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const decoder = new StringDecoder('utf8')
    const lines: string[] = []
    let pending = ''
    let stderr = ''
    let settled = false
    let limitReached = false
    let timedOut = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve({ lines, truncated: limitReached })
    }

    const acceptLine = (line: string) => {
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length === 0) return
      if (lines.length < maxLines) {
        lines.push(line)
        return
      }
      limitReached = true
      child.kill()
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (limitReached) return
      pending += decoder.write(chunk)
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      for (const line of parts) {
        acceptLine(line)
        if (limitReached) break
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString('utf8')
    })

    const onAbort = () => child.kill()
    signal.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, SEARCH_TIMEOUT_MS)

    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (!limitReached) {
        pending += decoder.end()
        if (pending) acceptLine(pending)
      }
      if (signal.aborted) return finish(abortError())
      if (timedOut) return finish(new Error(`搜索超时（${SEARCH_TIMEOUT_MS}ms）`))
      if (limitReached || code === 0 || code === 1) return finish()
      const detail = stderr.trim().slice(-MAX_STDERR_CHARS)
      finish(new Error(`ripgrep 执行失败（退出码 ${code ?? 'unknown'}）${detail ? `：${detail}` : ''}`))
    })
  })
}
