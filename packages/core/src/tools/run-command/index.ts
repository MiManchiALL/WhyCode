import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { z } from 'zod'
import {
  buildTool,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from '../tool.ts'
import { terminateProcessTree } from './process-termination.ts'

export const RUN_COMMAND_TOOL_NAME = 'RunCommand'

const MAX_OUTPUT_CHARS = 30_000
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 86_400_000
const QUOTED_ENV_PATH_RE = /["'](\$env:([A-Za-z_][A-Za-z0-9_]*)(?:[\\/][^"']*)?)["']/gi
const BARE_ENV_PATH_RE = /(?:^|[\s=(,])(\$env:([A-Za-z_][A-Za-z0-9_]*)(?:[\\/][^\s"'|<>)\],;]+)?)/gi

function encodePowerShellCommand(command: string): string {
  // powershell.exe 不会可靠透传最后一个原生命令的退出码，显式收口才能保留失败语义。
  const script = [
    command,
    '$__whycodeCommandSucceeded = $?',
    '$__whycodeCommandExitCode = $LASTEXITCODE',
    'if ($__whycodeCommandSucceeded) { exit 0 }',
    'if (($null -ne $__whycodeCommandExitCode) -and ($__whycodeCommandExitCode -ne 0)) { exit $__whycodeCommandExitCode }',
    'exit 1',
  ].join('\n')
  return Buffer.from(script, 'utf16le').toString('base64')
}

function spawnNonInteractiveCommand(
  command: string,
  cwd: string,
): ChildProcessByStdio<null, Readable, Readable> {
  const options = {
    cwd,
    windowsHide: true,
    // POSIX 以独立进程组启动，停止时才能连同 shell 的后代一起终止。
    detached: process.platform !== 'win32',
  }
  if (process.platform === 'win32') {
    return spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodePowerShellCommand(command),
    ], { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  }
  return spawn(command, { ...options, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
}

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

const foregroundInputSchema = z.object({
  command: z.string().min(1).describe('要执行的命令'),
  cwd: z.string().optional().describe('工作目录（绝对路径），默认项目目录'),
  timeoutMs: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional()
    .describe('前台命令超时毫秒数，默认 120000'),
})

const backgroundCapableInputSchema = foregroundInputSchema.extend({
  timeoutMs: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional()
    .describe('超时毫秒数；前台默认 120000，后台省略则不设超时'),
  runInBackground: z.boolean().optional()
    .describe('需要脱离当前工具步骤、跨回合继续运行并由后台任务工具管理时设 true；默认 false 并等待命令结束'),
  wakeOnCompletion: z.boolean().optional()
    .describe('仅在后台模式有效；若你需要在任务自然完成或失败后收到通知并自动继续，则设 true；默认 false'),
}).superRefine((input, ctx) => {
  if (input.wakeOnCompletion === true && input.runInBackground !== true) {
    ctx.addIssue({
      code: 'custom',
      path: ['wakeOnCompletion'],
      message: 'wakeOnCompletion=true 仅可与 runInBackground=true 同时使用',
    })
  }
})

type ForegroundRunCommandInput = z.infer<typeof foregroundInputSchema>
type RunCommandInput = z.infer<typeof backgroundCapableInputSchema>

export interface RunCommandToolOptions {
  startInBackground?: (
    input: Omit<RunCommandInput, 'runInBackground'>,
    ctx: ToolContext,
  ) => Promise<ToolResult>
}

export function createRunCommandTool(
  options: RunCommandToolOptions = {},
): ToolDefinition {
  const inputSchema: z.ZodType<RunCommandInput> = options.startInBackground
    ? backgroundCapableInputSchema
    : foregroundInputSchema
  const backgroundPrompt = options.startInBackground
    ? '需要让命令脱离当前工具步骤、跨回合继续运行时才设 runInBackground=true；后台模式会立即返回任务 ID，并由命令任务工具管理。若你需要在任务自然完成或失败后收到通知并自动继续，再设 wakeOnCompletion=true；否则不会自动通知。'
    : ''
  return buildTool({
    name: RUN_COMMAND_TOOL_NAME,
    description: options.startInBackground ? '执行前台命令或启动后台进程' : '执行终端命令',
    prompt:
      '在项目目录下执行 shell 命令（Windows 上为 PowerShell 5.1：不支持 && 链接符，多条命令用 ; 分隔或分多次调用）。' +
      '默认以前台非交互方式执行、等待终态且不接受 stdin；长安装、构建和测试仍保持前台，并按需设置足够的 timeoutMs。' +
      backgroundPrompt +
      '多行或包含复杂引号的非交付脚本先用 WriteFile 保存到环境提供的临时工作区，再执行脚本文件；需要交付的项目脚本写入项目目录。不要塞进 python -c 或 node -e。导入第三方包前先检查环境是否已有。' +
      '可用 cwd 指定工作目录（绝对路径）。创建、修改、删除或移动明确文件应使用 WriteFile/EditFile/DeleteFile/MoveFile，不要用命令绕过其路径授权。' +
      '命令产生的文件及外部副作用不建立检查点，无法回滚。' +
      '前台返回 stdout+stderr（超长截断尾部保留），默认超时 120 秒。',
    inputSchema,
    isReadOnly: false,
    kind: 'execute',
    extractPaths: (input) => [
      ...(input.cwd ? [input.cwd] : []),
      ...scanCommandPaths(input.command),
    ],
    async execute(input, ctx) {
      if (input.runInBackground === true && options.startInBackground) {
        const { runInBackground: _runInBackground, ...command } = input
        return options.startInBackground(command, ctx)
      }
      const {
        runInBackground: _runInBackground,
        wakeOnCompletion: _wakeOnCompletion,
        ...command
      } = input
      return executeForegroundCommand(command, ctx)
    },
  })
}

function executeForegroundCommand(
  input: ForegroundRunCommandInput,
  ctx: ToolContext,
): Promise<ToolResult> {
  return new Promise((resolvePromise) => {
    // 相对 cwd 按项目目录解析（与权限引擎判定基准一致），防 spawn 按进程目录解析造成错位。
    const cwd = input.cwd ? resolve(ctx.projectDir, input.cwd) : ctx.projectDir
    const child = spawnNonInteractiveCommand(input.command, cwd)

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
      resolvePromise({
        data: data || (isError ? '（命令失败，无标准输出）' : '（命令成功，无标准输出）'),
        isError,
      })
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
}

export const runCommandTool = createRunCommandTool()
