import { resolve } from 'node:path'
import { z } from 'zod'
import { buildTool, type ToolDefinition } from '../tool.ts'
import {
  createRunCommandTool,
  RUN_COMMAND_TOOL_NAME,
} from '../run-command/index.ts'
import { CommandSessionManager } from './manager.ts'
import type { CommandOutputChunk, CommandTaskSnapshot } from './types.ts'
import {
  GET_COMMAND_OUTPUT_TOOL_NAME,
  LIST_COMMANDS_TOOL_NAME,
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
  completed: CommandOutputChunk,
) {
  return {
    data:
      `${taskSummary(completed.task)}\n\n` +
      `命令输出（最多保留末尾 ${64 * 1024} 字节）：\n${completed.output || '（无输出）'}`,
    isError: completed.task.status !== 'completed',
  }
}

export interface CommandTools {
  runCommand: ToolDefinition
  taskTools: ToolDefinition[]
}

/** 为普通会话装配统一命令入口与会话隔离的后台任务控制工具。 */
export function createCommandTools(
  manager: CommandSessionManager,
  sessionId: string,
): CommandTools {
  const runCommand = createRunCommandTool({
    async startInBackground(input, ctx) {
      const { wakeOnCompletion, ...command } = input
      const task = await manager.start({
        sessionId,
        command: command.command,
        cwd: resolve(ctx.projectDir, command.cwd ?? '.'),
        timeoutMs: command.timeoutMs,
      })
      if (task.status !== 'running') {
        const offset = Math.max(0, task.outputBytes - 64 * 1024)
        return terminalTaskResult(await manager.readOutput(
          sessionId,
          task.id,
          offset,
          64 * 1024,
        ))
      }
      if (wakeOnCompletion !== true) {
        return {
          data:
            `${taskSummary(task)}\n\n` +
            `该命令已转入后台，不会在终态自动通知你；需要查看进度或交互时使用 ${GET_COMMAND_OUTPUT_TOOL_NAME}/${WRITE_COMMAND_INPUT_TOOL_NAME}。`,
          isError: false,
        }
      }
      const handoff = await manager.armTerminalNotification(
        sessionId,
        task.id,
        ctx.engagedPlanId,
      )
      if (!handoff.armed) {
        const offset = Math.max(0, handoff.task.outputBytes - 64 * 1024)
        return terminalTaskResult(await manager.readOutput(
          sessionId,
          task.id,
          offset,
          64 * 1024,
        ))
      }
      return {
        data:
          `${taskSummary(handoff.task)}\n\n` +
          `该命令已由 ${RUN_COMMAND_TOOL_NAME} 转入后台。自然进入 completed/failed 终态后，应用会通知你并自动继续；需要中间进度或交互时再使用 ${GET_COMMAND_OUTPUT_TOOL_NAME}/${WRITE_COMMAND_INPUT_TOOL_NAME}。`,
        isError: false,
      }
    },
  })
  const taskTools: ToolDefinition[] = [
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
        taskId: z.string().uuid().describe(`${RUN_COMMAND_TOOL_NAME} 后台模式返回的任务 ID`),
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
  return { runCommand, taskTools }
}

export { CommandSessionManager } from './manager.ts'
export {
  GET_COMMAND_OUTPUT_TOOL_NAME,
  LIST_COMMANDS_TOOL_NAME,
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
