import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConsensusAgentId } from './types.ts'

/**
 * 协商临时工作区位于会话 scratch 的 consensus 子树中；每个任务、Agent 独立。
 * 会话级创建、Fork、孤儿回收与删除由桌面宿主统一管理。
 */
export interface ConsensusTaskScratch {
  taskDir: string
  agentDirs: Record<ConsensusAgentId, string>
}

export async function createConsensusTaskScratch(
  sessionScratchDir: string,
  taskId: string,
): Promise<ConsensusTaskScratch> {
  const taskDir = join(sessionScratchDir, 'consensus', taskId)
  const agentDirs = {
    Main: join(taskDir, 'Main'),
    B: join(taskDir, 'B'),
    C: join(taskDir, 'C'),
  } satisfies Record<ConsensusAgentId, string>
  // 目录必须先存在：权限引擎的边界检查走 realpath，不存在的目录会被判越界
  await Promise.all(Object.values(agentDirs).map((dir) => mkdir(dir, { recursive: true })))
  return { taskDir, agentDirs }
}
