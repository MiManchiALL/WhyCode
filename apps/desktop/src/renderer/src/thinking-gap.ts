import type { AgentStatus } from '@whycode/core/events'
import type { Block } from './conversation-state.ts'

interface ThinkingGapState {
  blocks: readonly Block[]
  status: AgentStatus
  stopping: boolean
  workStartedAt: number | null
}

/**
 * 空窗反馈只从现有运行状态和时间线派生：模型尚未产生可见输出，或一个工具已经
 * 结束而下一事件尚未到达。运行中工具和流式内容已经有自己的反馈，不能重复展示。
 */
export function shouldShowThinkingGap({
  blocks,
  status,
  stopping,
  workStartedAt,
}: ThinkingGapState): boolean {
  if (
    workStartedAt === null
    || stopping
    || (status !== 'working' && status !== 'thinking')
  ) return false

  const currentWorkStart = lastWorkBoundary(blocks) + 1
  let hasUser = false
  for (let index = currentWorkStart; index < blocks.length; index++) {
    const block = blocks[index]
    if (!block) continue
    if (block.kind === 'user') hasUser = true
    if (isRunningTool(block)) return false
  }
  if (!hasUser) return false

  const latest = blocks.at(-1)
  if (!latest) return false
  if (latest.kind === 'user') return true
  if (latest.kind === 'tool') return latest.call.status !== 'running'
  return latest.kind === 'thinking' && latest.durationMs !== null
}

function lastWorkBoundary(blocks: readonly Block[]): number {
  return blocks.findLastIndex((block) => block.kind === 'work-duration')
}

function isRunningTool(block: Block): boolean {
  return block.kind === 'tool' && block.call.status === 'running'
}
