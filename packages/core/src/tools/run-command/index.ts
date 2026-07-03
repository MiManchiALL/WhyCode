import { spawn } from 'node:child_process'
import { z } from 'zod'
import { buildTool } from '../tool.ts'

export const BASH_TOOL_NAME = 'RunCommand'

const MAX_OUTPUT_CHARS = 30_000
const DEFAULT_TIMEOUT_MS = 120_000

export const runCommandTool = buildTool({
  name: BASH_TOOL_NAME,
  description: '执行终端命令',
  prompt:
    '在项目目录下执行 shell 命令（Windows 上为 PowerShell）。返回 stdout+stderr（超长截断尾部保留）。默认超时 120 秒。',
  inputSchema: z.object({
    command: z.string().describe('要执行的命令'),
    timeoutMs: z.number().int().min(1000).max(600_000).optional().describe('超时毫秒数'),
  }),
  isReadOnly: false,
  needsApproval: () => true,
  async execute(input, ctx) {
    return new Promise((resolvePromise) => {
      const child = spawn(input.command, {
        shell: process.platform === 'win32' ? 'powershell.exe' : true,
        cwd: ctx.projectDir,
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
