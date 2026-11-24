import { unicodeSafePrefix } from '../../text.ts'
import { localWorkspaceIO, workspacePathKey } from '../../workspace/io.ts'
import { displayToolPath } from '../fs-utils.ts'
import type { ToolContext } from '../tool.ts'
import { MAX_RETAINED_TERMINAL_TASKS } from './constants.ts'
import { isCommandTaskActive, type CommandTaskSnapshot } from './types.ts'

export function compactBackgroundTaskText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= maxChars ? normalized : unicodeSafePrefix(normalized, maxChars - 1) + '…'
}

function formatElapsed(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1_000))
  const minutes = Math.floor(seconds / 60)
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${minutes % 60}m`
  return minutes ? `${minutes}m${seconds % 60}s` : `${seconds}s`
}

export function formatCommandList(tasks: CommandTaskSnapshot[], pruned: boolean, ctx: ToolContext): string {
  if (!tasks.length) return '当前会话没有后台命令。'
  const now = Date.now()
  const io = ctx.workspaceIO ?? localWorkspaceIO
  const directories = new Map<string, Set<string>>()
  for (const task of tasks) {
    const key = workspacePathKey(io, task.cwd)
    const seen = directories.get(task.command)
    if (seen) seen.add(key)
    else directories.set(task.command, new Set([key]))
  }
  const lines = tasks.map(task => {
    const fields: string[] = [task.id, task.status]
    if (isCommandTaskActive(task.status)) fields.push('elapsed=' + formatElapsed(task.startedAt, now))
    else if (task.exitCode != null) fields.push('exit=' + task.exitCode)
    fields.push(compactBackgroundTaskText(task.command, 160))
    if (directories.get(task.command)!.size > 1) {
      fields.push('cwd=' + displayToolPath(ctx.projectDir, ctx.projectDir, task.cwd, io))
    }
    const exitReason = `退出码 ${task.exitCode ?? 'null'}`
    let reason = task.failureReason
    if (reason === exitReason) reason = undefined
    else if (reason?.startsWith(exitReason + '；')) reason = reason.slice(exitReason.length + 1)
    if (reason) fields.push('— ' + compactBackgroundTaskText(reason, 120))
    return fields.join('  ')
  })
  if (pruned) lines.push(`[更早的已结束命令已清理，每个会话最多保留 ${MAX_RETAINED_TERMINAL_TASKS} 条。]`)
  return lines.join('\n')
}
