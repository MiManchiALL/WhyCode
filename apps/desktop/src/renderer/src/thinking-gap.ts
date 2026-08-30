import type { AgentStatus } from '@whycode/core/events'
import type { Block } from './conversation-state.ts'

interface ThinkingGapState {
  blocks: readonly Block[]
  status: AgentStatus
  stopping: boolean
  workStartedAt: number | null
}

/**
 * 正文刚到达时本身就是反馈；只有短暂静默后才补上 Heart Wave，避免正常的
 * token/batch 间隔让指示器频繁闪烁。
 */
export const THINKING_GAP_VISIBLE_IDLE_MS = 1_000

/**
 * 返回 Heart Wave 的显示延迟：0 表示当前已经没有可见反馈，正数表示最近的静态
 * 内容仍算反馈、静默到阈值后再显示，null 表示另有持续反馈或当前并未运行。
 *
 * 这里刻意不读取 provider 的底层流活动。生成较大的工具参数时后台会持续收到
 * tool-input delta，但用户界面没有任何变化；它仍然属于需要 Heart Wave 的空窗。
 */
export function thinkingGapRevealDelay({
  blocks,
  status,
  stopping,
  workStartedAt,
}: ThinkingGapState): number | null {
  if (
    workStartedAt === null
    || stopping
    || (status !== 'working' && status !== 'thinking')
  ) return null

  const currentWorkStart = lastWorkBoundary(blocks) + 1
  let hasUser = false
  for (let index = currentWorkStart; index < blocks.length; index++) {
    const block = blocks[index]
    if (!block) continue
    if (block.kind === 'user') hasUser = true
    if (hasPersistentFeedback(block)) return null
  }
  if (!hasUser) return null

  const latest = blocks.at(-1)
  if (!latest || latest.kind === 'work-duration') return null
  if (
    latest.kind === 'user'
    || latest.kind === 'tool'
    || latest.kind === 'thinking'
  ) return 0
  return THINKING_GAP_VISIBLE_IDLE_MS
}

function lastWorkBoundary(blocks: readonly Block[]): number {
  return blocks.findLastIndex((block) => block.kind === 'work-duration')
}

function hasPersistentFeedback(block: Block): boolean {
  return (block.kind === 'tool' && block.call.status === 'running')
    || (block.kind === 'thinking' && block.durationMs === null)
    || (block.kind === 'peer' && block.peer.status === 'working')
}
