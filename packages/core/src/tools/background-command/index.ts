import { resolve } from 'node:path'
import { z } from 'zod'
import { buildTool, type ToolDefinition } from '../tool.ts'
import { BASH_TOOL_NAME, scanCommandPaths } from '../run-command/index.ts'
import { CommandSessionManager } from './manager.ts'
import type { CommandTaskSnapshot } from './types.ts'
import {
  GET_COMMAND_OUTPUT_TOOL_NAME,
  LIST_COMMANDS_TOOL_NAME,
  START_COMMAND_TOOL_NAME,
  STOP_COMMAND_TOOL_NAME,
  WRITE_COMMAND_INPUT_TOOL_NAME,
} from './constants.ts'

function taskSummary(task: CommandTaskSnapshot): string {
  const command = task.command.length > 1_000
    ? `${task.command.slice(0, 1_000)}…（命令已截断）`
    : task.command
  const details = [
    `任务 ID：${task.id}`,
    `状态：${task.status}`,
    `命令：${command}`,
    `工作目录：${task.cwd}`,
    `输出字节：${task.outputBytes}${task.outputTruncated ? '（已达到日志上限，后续输出被丢弃）' : ''}`,
  ]
  if (task.exitCode !== undefined) details.push(`退出码：${task.exitCode ?? '未知'}`)
  if (task.failureReason) details.push(`说明：${task.failureReason}`)
  return details.join('\n')
}

function terminalTaskResult(
  completed: Awaited<ReturnType<CommandSessionManager['waitForTerminal']>>,
) {
  return {
    data:
      `${taskSummary(completed.task)}\n\n` +
      `命令输出（最多保留末尾 ${64 * 1024} 字符）：\n${completed.output || '（无输出）'}`,
    isError: completed.task.status !== 'completed',
  }
}

/** 为当前 Main 会话绑定后台命令工具；任务 ID 不能跨会话访问。 */
export function createBackgroundCommandTools(
  manager: CommandSessionManager,
  sessionId: string,
): ToolDefinition[] {
  return [
    buildTool({
      name: START_COMMAND_TOOL_NAME,
      description: '启动长命令；默认等待终态，持久服务才显式脱离',
      prompt:
        `启动确实需要长时间运行的命令。安装、构建、测试和其它有限任务保持 detach=false（默认），工具会等待终态、流式返回输出，然后当前任务自动继续；模型不得用文字承诺稍后回来。普通短命令继续使用 ${BASH_TOOL_NAME}。` +
        `只有开发服务器、watch 或明确需要跨回合 stdin 的持久进程才设 detach=true；此时返回任务 ID 后，用 ${GET_COMMAND_OUTPUT_TOOL_NAME} 增量读取，需要输入时用 ${WRITE_COMMAND_INPUT_TOOL_NAME}，结束时用 ${STOP_COMMAND_TOOL_NAME}。` +
        '显式脱离的命令在切换对话后继续运行；进入 completed/failed 终态时，应用会把内部任务通知送回所属 Main 并自动续轮。不要用 Sleep 或高频轮询等待完成；只有需要查看中间进度时才读取输出。应用退出时终止，重启只保留日志和终态，不重连进程。命令的延迟文件副作用不能自动回滚。' +
        '这是管道而非完整 TTY，不适合 vim 等全屏交互程序。',
      inputSchema: z.object({
        command: z.string().min(1).describe('要执行的命令'),
        cwd: z.string().optional().describe('工作目录（绝对路径），默认项目目录'),
        timeoutMs: z.number().int().min(1000).max(86_400_000).optional().describe('可选超时毫秒数；省略则运行到自行结束、停止或应用退出'),
        detach: z.boolean().optional().describe('仅持久服务/watch 设 true；有限任务省略或设 false并等待终态'),
      }),
      isReadOnly: false,
      kind: 'execute',
      extractPaths: (input) => [
        ...(input.cwd ? [input.cwd] : []),
        ...scanCommandPaths(input.command),
      ],
      async execute(input, ctx) {
        const task = await manager.start({
          sessionId,
          command: input.command,
          cwd: resolve(ctx.projectDir, input.cwd ?? '.'),
          timeoutMs: input.timeoutMs,
        })
        if (!input.detach) {
          const completed = await manager.waitForTerminal(
            sessionId,
            task.id,
            ctx.abortSignal,
            ctx.onProgress,
          )
          return terminalTaskResult(completed)
        }
        const handoff = await manager.armTerminalNotification(
          sessionId,
          task.id,
          ctx.engagedPlanId,
        )
        if (!handoff.armed) {
          return terminalTaskResult(await manager.waitForTerminal(
            sessionId,
            task.id,
            ctx.abortSignal,
            ctx.onProgress,
          ))
        }
        return {
          data:
            `${taskSummary(handoff.task)}\n\n` +
            '该持久进程已脱离当前工具调用。进入 completed/failed 终态后，应用会自动通知并唤醒所属 Main；需要中间进度或交互时再使用 GetCommandOutput/WriteCommandInput。',
          isError: false,
        }
      },
    }),
    buildTool({
      name: LIST_COMMANDS_TOOL_NAME,
      description: '列出当前会话的后台命令',
      prompt:
        '列出当前会话保留的后台命令及任务 ID、状态、命令和工作目录。切回旧会话、上下文压缩后忘记任务 ID，或准备启动重复服务前使用。',
      inputSchema: z.object({}),
      isReadOnly: true,
      kind: 'read',
      async execute() {
        const tasks = await manager.list(sessionId)
        return {
          data: tasks.length === 0
            ? '当前会话没有后台命令。'
            : tasks.map((task, index) => `#${index + 1}\n${taskSummary(task)}`).join('\n\n'),
          isError: false,
        }
      },
    }),
    buildTool({
      name: GET_COMMAND_OUTPUT_TOOL_NAME,
      description: '增量读取后台命令输出和状态',
      prompt:
        '按字节偏移增量读取后台命令日志，并返回最新状态、nextOffset 与是否还有更多。运行中暂无新输出时可用 waitMs 等待，避免高频轮询。',
      inputSchema: z.object({
        taskId: z.string().uuid().describe(`${START_COMMAND_TOOL_NAME} 返回的任务 ID`),
        offset: z.number().int().nonnegative().optional().describe('从该字节偏移开始，首次省略或传 0；后续使用上次 nextOffset'),
        maxBytes: z.number().int().min(1024).max(65_536).optional().describe('本次最多读取字节数，默认 32768'),
        waitMs: z.number().int().min(0).max(30_000).optional().describe('没有新输出且仍在运行时最多等待多久，默认不等待'),
      }),
      isReadOnly: true,
      kind: 'read',
      async execute(input) {
        const chunk = await manager.readOutput(
          sessionId,
          input.taskId,
          input.offset,
          input.maxBytes,
          input.waitMs,
        )
        const header = `${taskSummary(chunk.task)}\n读取偏移：${chunk.offset} → ${chunk.nextOffset}`
        return { data: `${header}\n\n${chunk.output || '（本次没有新输出）'}`, isError: false }
      },
    }),
    buildTool({
      name: WRITE_COMMAND_INPUT_TOOL_NAME,
      description: '向运行中的后台命令写入标准输入',
      prompt: '向当前会话中仍在运行的后台命令写入 stdin。默认在输入末尾追加换行；只用于已启动任务，不会开启新命令。',
      inputSchema: z.object({
        taskId: z.string().uuid().describe('后台任务 ID'),
        input: z.string().max(100_000).describe('写入内容'),
        appendNewline: z.boolean().optional().describe('是否追加换行，默认 true'),
        closeAfterWrite: z.boolean().optional().describe('写入后是否关闭 stdin（发送 EOF），默认 false'),
      }),
      isReadOnly: false,
      // stdin 可让既有进程产生文件或外部副作用，不属于只改变会话内部状态的 control。
      kind: 'execute',
      async execute(input) {
        const task = await manager.writeInput(
          sessionId,
          input.taskId,
          input.input + (input.appendNewline === false ? '' : '\n'),
          input.closeAfterWrite,
        )
        return { data: `输入已写入。\n${taskSummary(task)}`, isError: false }
      },
    }),
    buildTool({
      name: STOP_COMMAND_TOOL_NAME,
      description: '停止后台命令及其进程树',
      prompt: '停止当前会话中的后台命令，并终止其完整进程树。对已结束任务调用是幂等的，只返回现有终态。',
      inputSchema: z.object({
        taskId: z.string().uuid().describe('后台任务 ID'),
      }),
      isReadOnly: false,
      kind: 'control',
      async execute(input) {
        const task = await manager.stop(sessionId, input.taskId)
        return { data: taskSummary(task), isError: false }
      },
    }),
  ]
}

export { CommandSessionManager } from './manager.ts'
export {
  GET_COMMAND_OUTPUT_TOOL_NAME,
  LIST_COMMANDS_TOOL_NAME,
  START_COMMAND_TOOL_NAME,
  STOP_COMMAND_TOOL_NAME,
  WRITE_COMMAND_INPUT_TOOL_NAME,
} from './constants.ts'
export type {
  BackgroundTaskState,
  BackgroundTaskSummary,
  CommandOutputChunk,
  CommandTaskSnapshot,
  CommandTaskStatus,
  CommandTaskTerminalNotification,
} from './types.ts'
