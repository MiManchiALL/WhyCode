import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { z } from 'zod'
import { buildTool } from '../tool.ts'

export const BASH_TOOL_NAME = 'RunCommand'

const MAX_OUTPUT_CHARS = 30_000
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * 从命令串里扫出绝对路径（Windows 盘符风格），供权限引擎做敏感/边界/讨论档判定。
 * 保守启发式：漏报走「execute 默认审批」兜底，误报最多多弹一次窗。
 */
export function scanCommandPaths(command: string): string[] {
  const found = new Set<string>()
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

export const runCommandTool = buildTool({
  name: BASH_TOOL_NAME,
  description: '执行终端命令',
  prompt:
    '在项目目录下执行 shell 命令（Windows 上为 PowerShell 5.1：不支持 && 链接符，多条命令用 ; 分隔或分多次调用）。' +
    '可用 cwd 指定工作目录（绝对路径）。返回 stdout+stderr（超长截断尾部保留）。默认超时 120 秒。',
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
  async execute(input, ctx) {
    return new Promise((resolvePromise) => {
      const child = spawn(input.command, {
        shell: process.platform === 'win32' ? 'powershell.exe' : true,
        // 相对 cwd 按项目目录解析（与权限引擎判定基准一致），防 spawn 按进程目录解析造成错位
        cwd: input.cwd ? resolve(ctx.projectDir, input.cwd) : ctx.projectDir,
        windowsHide: true,
      })

      let output = ''
      const append = (chunk: Buffer) => {
        const text = chunk.toString('utf-8')
        output += text
        ctx.onProgress?.(text)
      }
      child.stdout.on('data', append)
      child.stderr.on('data', append)

      const timeout = setTimeout(() => {
        child.kill()
        finish(`[命令超时（${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms），已终止]\n`, true)
      }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS)

      const onAbort = () => {
        child.kill()
        finish('[已被用户中断]\n', true)
      }
      ctx.abortSignal.addEventListener('abort', onAbort, { once: true })

      let done = false
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

      child.on('close', (code) => {
        finish(code === 0 ? '' : `\n[退出码 ${code}]`, code !== 0)
      })
      child.on('error', (err) => finish(`[启动失败：${err.message}]`, true))
    })
  },
})
