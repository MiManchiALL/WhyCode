import { localWorkspaceIO, type WorkspaceIO } from '../../workspace/io.ts'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { ToolResultError } from '../tool.ts'
import { SEARCH_EXCLUDED_DIRS } from './file-filters.ts'

const MAX_STDERR_CHARS = 4_000
const MAX_LINE_CHARS = 64 * 1024

// 匹配任意深度的目录本身才能在进入前剪枝；仅排除其内容仍会读取目录。
const SEARCH_EXCLUSIONS = SEARCH_EXCLUDED_DIRS.flatMap(dir => ['--glob', `!**/${dir}`])

export function ripgrepFileArgs(gitignore: boolean, pattern?: string): string[] {
  const args = ['--hidden', gitignore ? '--no-require-git' : '--no-ignore', '--sort', 'path', ...SEARCH_EXCLUSIONS]
  if (!pattern) return args
  // 正向 --glob 会覆盖忽略规则。--type 只预筛两边语法一致的文件名通配与简单枚举。
  // 冒号是类型定义分隔符，字符类和范围展开统一交给相对路径的 minimatch 匹配。
  const leaf = pattern.slice(pattern.lastIndexOf('/') + 1)
  const simpleGlob = leaf.replace(/\{[\w.-]+(?:,[\w.-]+)+\}/g, '*')
  if (simpleGlob && !/[:{}[\]]/.test(simpleGlob)) {
    args.push('--type-add', `whycode:${leaf}`, '--type', 'whycode')
  }
  return args
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

/**
 * 执行 ripgrep 并按行流式截断，避免大仓库搜索先把全部 stdout 放进内存。
 * code=1 表示无匹配，仍属于成功；达到行数上限时主动结束 rg 并返回部分结果。
 */
export async function runRipgrepLines(
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onLine: (line: string) => boolean,
  io: WorkspaceIO = localWorkspaceIO,
): Promise<boolean> {
  signal.throwIfAborted()
  const executable = !io.ripgrep && io.identity === 'local' ? io.ripgrepPath ?? await getRipgrepPath() : null
  signal.throwIfAborted()
  if (!io.ripgrep && !executable) return false

  return new Promise<boolean>((resolve, reject) => {
    const argv = ['--no-config', '--line-buffered', ...args]
    const child = io.ripgrep ? io.ripgrep(argv, cwd) : spawn(executable!, argv, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const decoder = new StringDecoder('utf8')
    let pending = ''
    let stderr = ''
    let settled = false
    let limitReached = false
    let stopping: Promise<boolean> | undefined

    const stop = () => {
      if ('terminate' in child) {
        stopping ??= child.terminate()
        void stopping.catch(finish)
      } else {
        // 直接启动的 rg 没有 shell 或子进程。
        child.kill()
      }
    }

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve(true)
    }

    const acceptLine = (line: string) => {
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line.length === 0) return
      try {
        if (line.length > MAX_LINE_CHARS) throw new Error('搜索输出单行超过限制，请缩小搜索范围')
        if (!onLine(line)) { limitReached = true; stop() }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
        stop()
      }
    }

    child.stdout!.on('data', (chunk: Buffer) => {
      if (settled || limitReached || signal.aborted) return
      pending += decoder.write(chunk)
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      for (const line of parts) {
        acceptLine(line)
        if (limitReached || settled) return
      }
      if (pending.length > MAX_LINE_CHARS) { stop(); finish(new Error('搜索输出单行超过限制，请缩小搜索范围')) }
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_CHARS)
    })

    const onAbort = () => { stop(); finish(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })

    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (settled) return
      if (!limitReached) {
        pending += decoder.end()
        if (pending) acceptLine(pending)
      }
      if (signal.aborted) return finish(signal.reason)
      if (limitReached || code === 0 || code === 1) return finish()
      const detail = stderr.trim().slice(-MAX_STDERR_CHARS)
      finish(new ToolResultError(detail || `ripgrep 执行失败（退出码 ${code ?? '未知'}）`))
    })
    child.stdin?.end()
    if (signal.aborted) onAbort()
  })
}
