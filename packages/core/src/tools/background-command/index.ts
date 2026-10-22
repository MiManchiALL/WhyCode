import { localWorkspaceIO } from '../../workspace/io.ts'
import { unicodeSafePrefix } from '../../text.ts'
import { buildTool, type ToolDefinition } from '../tool.ts'
import {
  createRunCommandTool,
  RUN_COMMAND_TOOL_NAME,
} from '../run-command/index.ts'
import { CommandSessionManager } from './manager.ts'
import { isCommandTaskActive, type CommandOutputChunk, type CommandTaskSnapshot } from './types.ts'
import { MANAGE_COMMAND_TOOL_NAME } from './constants.ts'
import { manageCommandInputSchema } from './input.ts'
import { MANAGE_COMMAND_PROMPT } from './prompt.ts'

function taskSummary(task: CommandTaskSnapshot): string {
  const command = task.command.length > 1_000
    ? `${unicodeSafePrefix(task.command, 1_000)}…（命令已截断）`
    : task.command
  const details = [
    `任务 ID：${task.id}`,
    `状态：${task.status}`,
    `命令：${command}`,
    `工作目录：${task.cwd}`,
    `输出字节：${task.outputBytes}`,
    `可写入输入：${task.canWrite ? '是' : '否'}`,
  ]
  if (task.exitCode !== undefined) details.push(`退出码：${task.exitCode ?? '未知'}`)
  if (task.failureReason) details.push(`说明：${task.failureReason}`)
  return details.join('\n')
}

function outputSummary(chunk: CommandOutputChunk): string {
  return [
    `offset: ${chunk.offset}; nextOffset: ${chunk.nextOffset}; hasMore: ${chunk.hasMore}`,
    ...(chunk.partialLine ? ['本次包含长行或续接行的片段；完整日志仍保留，使用 nextOffset 可继续读取。'] : []),
  ].join('\n')
}

function terminalTaskResult(
  completed: CommandOutputChunk,
) {
  return {
    data:
      `${taskSummary(completed.task)}\n\n` +
      `命令输出（末尾窗口；完整日志可用 ${MANAGE_COMMAND_TOOL_NAME} 读取）：\n${outputSummary(completed)}\n${completed.output || '（无输出）'}`,
    isError: completed.task.status !== 'completed',
  }
}

export interface CommandTools {
  runCommand: ToolDefinition
  manageCommand: ToolDefinition
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
        cwd: (ctx.workspaceIO ?? localWorkspaceIO).path.resolve(ctx.projectDir, command.cwd ?? '.'),
        workspaceIO: ctx.workspaceIO,
        timeoutMs: command.timeoutMs,
      })
      if (!isCommandTaskActive(task.status)) {
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
            `该命令已转入后台，自然完成或失败时不会自动通知你；用户手动停止时会通知。需要查看进度或交互时使用 ${MANAGE_COMMAND_TOOL_NAME}。`,
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
          `该命令已由 ${RUN_COMMAND_TOOL_NAME} 转入后台。自然进入 completed/failed 终态后，应用会通知你并自动继续；需要中间进度或交互时再使用 ${MANAGE_COMMAND_TOOL_NAME}。`,
        isError: false,
      }
    },
  })
  const manageCommand = buildTool({
    name: MANAGE_COMMAND_TOOL_NAME,
    description: '查看和管理当前会话的后台命令',
    prompt: MANAGE_COMMAND_PROMPT,
    inputSchema: manageCommandInputSchema,
    behavior: ({ action }) => action === 'list' || action === 'read'
      ? { kind: 'read', isReadOnly: true }
      : { kind: action === 'stop' ? 'control' : 'execute', isReadOnly: false },
    async execute(input, ctx) {
      if (input.action === 'list') {
        const tasks = await manager.list(sessionId)
        return {
          data: tasks.length === 0 ? '当前会话没有后台命令。'
            : tasks.map((task, index) => `#${index + 1}\n${taskSummary(task)}`).join('\n\n'),
          isError: false,
        }
      }
      const taskId = input.taskId!
      if (input.action === 'read') {
        const chunk = await manager.readOutput(sessionId, taskId, input.offset, undefined, input.waitMs, ctx.abortSignal)
        return {
          data: `${taskSummary(chunk.task)}\n${outputSummary(chunk)}\n\n${chunk.output || '（本次没有新输出）'}`,
          isError: false,
        }
      }
      if (input.action === 'stop') {
        return { data: taskSummary(await manager.stop(sessionId, taskId, { source: 'model', detail: input.reason })), isError: false }
      }
      const closing = input.action === 'close'
      const task = await manager.writeInput(sessionId, taskId, input.input ?? '', closing, ctx.abortSignal)
      return { data: `${closing ? '标准输入已关闭（EOF）。' : '输入已写入。'}\n${taskSummary(task)}`, isError: false }
    },
  })
  return { runCommand, manageCommand }
}

export { CommandSessionManager } from './manager.ts'
export { isCommandTaskActive } from './types.ts'
export { MANAGE_COMMAND_TOOL_NAME } from './constants.ts'
export type {
  BackgroundTaskState,
  BackgroundTaskSummary,
  CommandOutputChunk,
  CommandTaskSnapshot,
  CommandTaskStatus,
  CommandTaskTerminalNotification,
} from './types.ts'
