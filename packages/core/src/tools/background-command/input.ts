import { z } from 'zod'
import { MAX_COMMAND_STOP_REASON_CHARS } from './constants.ts'

export const manageCommandInputSchema = z.strictObject({
  action: z.enum(['list', 'read', 'write', 'close', 'stop']).describe('列出、读取、写入、关闭输入或停止后台命令'),
  taskId: z.string().uuid().optional().describe('后台任务 ID；除 list 外必填'),
  input: z.string().max(100_000).optional().describe('write 必填，close 可选；按原样写入，不自动追加换行'),
  offset: z.number().int().nonnegative().optional().describe('仅 read：字节偏移，默认 0；后续使用返回的 nextOffset'),
  waitMs: z.number().int().min(0).max(30_000).optional().describe('仅 read：暂无新输出时的最长等待毫秒数，默认 0'),
  reason: z.string().trim().min(1).max(MAX_COMMAND_STOP_REASON_CHARS)
    .regex(/^[^\r\n]*$/, '停止原因请使用单行文字').optional().describe('仅 stop：简短的停止原因'),
}).superRefine((input, ctx) => {
  if (input.action !== 'list' && !input.taskId) {
    ctx.addIssue({ code: 'custom', path: ['taskId'], message: `${input.action} 必须提供 taskId` })
  }
  if (input.action === 'write' && input.input === undefined) {
    ctx.addIssue({ code: 'custom', path: ['input'], message: 'write 必须提供 input' })
  }
  const allowed = {
    taskId: input.action !== 'list',
    input: input.action === 'write' || input.action === 'close',
    offset: input.action === 'read',
    waitMs: input.action === 'read',
    reason: input.action === 'stop',
  }
  for (const key of Object.keys(allowed) as (keyof typeof allowed)[]) {
    if (!allowed[key] && input[key] !== undefined) {
      ctx.addIssue({ code: 'custom', path: [key], message: `${input.action} 不接受 ${key}` })
    }
  }
})
