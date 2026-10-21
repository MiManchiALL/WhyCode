import { localWorkspaceIO } from '../../workspace/io.ts'
import { stopWorkspaceProcess } from '../../workspace/process.ts'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { CommandOutput, captureCommandOutput } from './output.ts'
import { COMMAND_PREVIEW_BYTES, COMMAND_PREVIEW_LINES, serializeCommandOutputResult } from './output-result.ts'
import { z } from 'zod'
import { TOOL_OUTCOME_UNKNOWN } from '../../session/tool-execution.ts'
import { turnAbortReason } from '../../session/interruption.ts'
import { powerShellCommandArgs } from '../powershell.ts'
import {
  buildTool,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from '../tool.ts'

export const RUN_COMMAND_TOOL_NAME = 'RunCommand'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 86_400_000
const QUOTED_ENV_PATH_RE = /["'](\$env:([A-Za-z_][A-Za-z0-9_]*)(?:[\\/][^"']*)?)["']/gi
const BARE_ENV_PATH_RE = /(?:^|[\s=(,])(\$env:([A-Za-z_][A-Za-z0-9_]*)(?:[\\/][^\s"'|<>)\],;]+)?)/gi

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
      '-NonInteractive',
      ...powerShellCommandArgs(command),
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
    ? '需要让命令脱离当前工具步骤、跨回合继续运行时才设 runInBackground=true；后台模式会立即返回任务 ID，并由命令任务工具管理。若你需要在任务自然完成或失败后收到通知并自动继续，再设 wakeOnCompletion=true；用户从后台任务菜单手动停止时会单独通知。'
    : ''
  return buildTool({
    name: RUN_COMMAND_TOOL_NAME,
    description: options.startInBackground ? '执行前台命令或启动后台进程' : '执行终端命令',
    prompt:
      '在项目目录下执行 shell 命令（Windows 上为 PowerShell 5.1：不支持 && 链接符，多条命令用 ; 分隔或分多次调用）。' +
      '默认以前台非交互方式执行、等待终态且不接受 stdin；长安装、构建和测试仍保持前台，并按需设置足够的 timeoutMs。' +
      backgroundPrompt +
      '多行或包含复杂引号的非交付脚本先用 WriteFile 保存到环境提供的临时工作区，再执行脚本文件；需要交付的项目脚本写入项目目录。不要塞进 python -c 或 node -e。导入第三方包前先检查环境是否已有。' +
      '可用 cwd 指定工作目录（绝对路径）。创建、修改或删除明确文件应使用 WriteFile/EditFile/DeleteFile。移动或重命名文件可使用本工具，先确认目标不存在，避免覆盖；命令的文件副作用没有精确检查点。' +
      '命令产生的文件及外部副作用不建立检查点，无法回滚。' +
      `前台返回 stdout+stderr，默认超时 120 秒。输出超过 ${COMMAND_PREVIEW_LINES} 行或 ${COMMAND_PREVIEW_BYTES / 1024} KiB 时，完整 UTF-8 日志保存到当前角色的会话临时目录 command-output/；` +
      '结果返回 command-output JSON：output 只含尾部完整行（单行超限时省略），fullOutputPath 是完整日志路径，可用 ReadFile 分页读取或 Grep 搜索。日志随会话删除；保存失败会停止命令并明确报错。',
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

async function executeForegroundCommand(
  input: ForegroundRunCommandInput,
  ctx: ToolContext,
): Promise<ToolResult> {
  // 相对 cwd 按项目目录解析（与权限引擎判定基准一致），防 spawn 按进程目录解析造成错位。
  const io = ctx.workspaceIO ?? localWorkspaceIO
  const cwd = io.path.resolve(ctx.projectDir, input.cwd ?? '.')
  const child = io.spawn ? io.spawn(input.command, cwd) : spawnNonInteractiveCommand(input.command, cwd)
  const output = new CommandOutput(io, ctx.scratchDirectory, ctx.onProgress)
  let outputError: Error | undefined
  let captured: Promise<void>
  const outcome = await new Promise<{ suffix: string; isError: boolean }>((resolvePromise) => {
    let done = false
    let stopping = false
    const finish = (suffix: string, isError: boolean) => {
      if (done) return
      done = true
      clearTimeout(timeout)
      ctx.abortSignal.removeEventListener('abort', onAbort)
      resolvePromise({ suffix, isError })
    }

    const requestStop = (reason: 'timeout' | 'abort' | 'output') => {
      if (done || stopping) return
      stopping = true
      void stopWorkspaceProcess(child)
        .catch(() => false)
        .then((treeStopped) => {
          const suffix =
            reason === 'timeout'
              ? `[命令超时（${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms），已请求终止]`
              : reason === 'output'
                ? '[命令输出保存失败，已请求终止]'
                : turnAbortReason(ctx.abortSignal) === 'user-cancel'
                ? '[用户已停止]'
                : '[应用关闭或进程中断，命令已停止]'
          const warning = treeStopped ? '' : '\n[警告：未能确认全部子进程均已终止]'
          if (!treeStopped) output.destroy(new Error('未能确认命令停止，输出可能不完整'))
          finish(`${suffix}${warning}\n${TOOL_OUTCOME_UNKNOWN}\n`, true)
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
      if (!stopping) finish(`[命令失败：${err.message}]`, true)
    })
    captured = captureCommandOutput([child.stdout, child.stderr], output).catch(error => {
      outputError = error instanceof Error ? error : new Error(String(error))
      requestStop('output')
    })
    // 远端命令与本地 ignore stdin 保持一致，不能等待无人提供的输入。
    child.stdin?.end()
    // AbortSignal 在监听器注册前已中止时不会补发事件，必须显式检查。
    if (ctx.abortSignal.aborted) requestStop('abort')
  })
  // 进程 close（尤其 SSH）不代表消费端及文件已排空；工具结果必须等句柄关闭。
  await captured!
  const isError = outcome.isError || !!outputError
  const diagnostic = [outcome.suffix, outputError ? `[完整输出未保存：${outputError.message}]` : ''].filter(Boolean).join('\n')
  const preview = output.preview()
  const data = output.truncated
    ? serializeCommandOutputResult({
      type: 'command-output', output: preview, totalBytes: output.totalBytes, totalLines: output.totalLines,
      ...(output.fullOutputPath ? { fullOutputPath: output.fullOutputPath } : {}),
      ...(diagnostic ? { diagnostic } : {}),
    })
    : preview + diagnostic
  return { data: data || (isError ? '（命令失败，无标准输出）' : '（命令成功，无标准输出）'), isError }
}

export const runCommandTool = createRunCommandTool()
