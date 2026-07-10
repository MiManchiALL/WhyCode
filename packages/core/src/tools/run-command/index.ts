import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import { buildTool } from '../tool.ts'
import { terminateProcessTree } from './process-termination.ts'

export const BASH_TOOL_NAME = 'RunCommand'

const MAX_OUTPUT_CHARS = 30_000
const DEFAULT_TIMEOUT_MS = 120_000
const QUOTED_ENV_PATH_RE = /["'](\$env:([A-Za-z_][A-Za-z0-9_]*)(?:[\\/][^"']*)?)["']/gi
const BARE_ENV_PATH_RE = /(?:^|[\s=(,])(\$env:([A-Za-z_][A-Za-z0-9_]*)(?:[\\/][^\s"'|<>)\],;]+)?)/gi

function expandEnvironmentPath(raw: string, name: string): string | null {
  const value = Object.entries(process.env).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1]
  if (!value || !isAbsolute(value)) return null
  const suffix = raw.slice(raw.indexOf(name) + name.length)
  return resolve(`${value}${suffix}`)
}

/**
 * 从命令串里扫出绝对路径（Windows 盘符风格），供权限引擎做敏感/边界/讨论档判定。
 * 保守启发式：漏报走「execute 默认审批」兜底，误报最多多弹一次窗。
 */
export function scanCommandPaths(command: string): string[] {
  const found = new Set<string>()
  // PowerShell 常用的 $env:USERPROFILE\Desktop 写法也必须进入权限与检查点边界。
  for (const match of command.matchAll(QUOTED_ENV_PATH_RE)) {
    const expanded = expandEnvironmentPath(match[1]!, match[2]!)
    if (expanded) found.add(expanded)
  }
  for (const match of command.matchAll(BARE_ENV_PATH_RE)) {
    const expanded = expandEnvironmentPath(match[1]!, match[2]!)
    if (expanded) found.add(expanded)
  }
  // 引号内的完整路径（可含空格）优先
  for (const m of command.matchAll(/["']([A-Za-z]:[\\/][^"']*)["']/g)) {
    found.add(m[1]!)
  }
  // 裸路径 token（到空白或 shell 元字符为止）
  for (const m of command.matchAll(/(?:^|[\s=(,])([A-Za-z]:[\\/][^\s"'|<>)\],;]+)/g)) {
    found.add(m[1]!)
  }
  return [...found]
}

async function checkpointRoot(path: string): Promise<string> {
  const absolute = resolve(path)
  const stats = await lstat(absolute).catch(() => null)
  return stats?.isDirectory() ? absolute : dirname(absolute)
}

export const runCommandTool = buildTool({
  name: BASH_TOOL_NAME,
  description: '执行终端命令',
  prompt:
    '在项目目录下执行 shell 命令（Windows 上为 PowerShell 5.1：不支持 && 链接符，多条命令用 ; 分隔或分多次调用）。' +
    '可用 cwd 指定工作目录（绝对路径）。创建或修改明确的单个文件应使用 WriteFile/EditFile，不要用命令绕过其路径授权。' +
    '返回 stdout+stderr（超长截断尾部保留）。默认超时 120 秒。',
  inputSchema: z.object({
    command: z.string().describe('要执行的命令'),
    cwd: z.string().optional().describe('工作目录（绝对路径），默认项目目录'),
    timeoutMs: z.number().int().min(1000).max(600_000).optional().describe('超时毫秒数'),
  }),
  isReadOnly: false,
  kind: 'execute',
  extractPaths: (input) => [
    ...(input.cwd ? [input.cwd] : []),
    ...scanCommandPaths(input.command),
  ],
  async checkpointScope(input, ctx) {
    const cwd = resolve(ctx.projectDir, input.cwd ?? '.')
    const candidates = [ctx.projectDir, cwd, ...scanCommandPaths(input.command)]
    const roots = await Promise.all(candidates.map(checkpointRoot))
    return {
      kind: 'workspace-roots',
      roots,
      warning: '命令可影响进程、网络及未识别路径；依赖、缓存、敏感文件和大型二进制也不纳入树快照。',
    }
  },
  async execute(input, ctx) {
    return new Promise((resolvePromise) => {
      const child = spawn(input.command, {
        shell: process.platform === 'win32' ? 'powershell.exe' : true,
        // 相对 cwd 按项目目录解析（与权限引擎判定基准一致），防 spawn 按进程目录解析造成错位
        cwd: input.cwd ? resolve(ctx.projectDir, input.cwd) : ctx.projectDir,
        windowsHide: true,
        // POSIX 以独立进程组启动，停止时才能连同 shell 的后代一起终止。
        detached: process.platform !== 'win32',
      })

      let output = ''
      let done = false
      let stopping: 'timeout' | 'abort' | null = null
      const append = (chunk: Buffer) => {
        if (done) return
        const text = chunk.toString('utf-8')
        output += text
        ctx.onProgress?.(text)
      }
      child.stdout.on('data', append)
      child.stderr.on('data', append)

      const finish = (suffix: string, isError: boolean) => {
        if (done) return
        done = true
        clearTimeout(timeout)
        ctx.abortSignal.removeEventListener('abort', onAbort)
        let data = output + suffix
        if (data.length > MAX_OUTPUT_CHARS) {
          data = `[输出过长，仅保留尾部 ${MAX_OUTPUT_CHARS} 字符]\n` + data.slice(-MAX_OUTPUT_CHARS)
        }
        resolvePromise({ data: data || '（无输出）', isError })
      }

      const requestStop = (reason: 'timeout' | 'abort') => {
        if (done || stopping) return
        stopping = reason
        void terminateProcessTree(child)
          .catch(() => false)
          .then((treeStopped) => {
            const suffix =
              reason === 'timeout'
                ? `[命令超时（${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms），已请求终止]`
                : '[已被用户中断]'
            const warning = treeStopped ? '' : '\n[警告：未能确认全部子进程均已终止]'
            finish(`${suffix}${warning}\n`, true)
          })
      }
      const timeout = setTimeout(
        () => requestStop('timeout'),
        input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
      const onAbort = () => requestStop('abort')
      ctx.abortSignal.addEventListener('abort', onAbort, { once: true })

      child.on('close', (code) => {
        if (stopping) return
        finish(code === 0 ? '' : `\n[退出码 ${code}]`, code !== 0)
      })
      child.on('error', (err) => {
        if (!stopping) finish(`[启动失败：${err.message}]`, true)
      })
      // AbortSignal 在监听器注册前已中止时不会补发事件，必须显式检查。
      if (ctx.abortSignal.aborted) requestStop('abort')
    })
  },
})
