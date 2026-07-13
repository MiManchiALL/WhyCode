import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConsensusAgentId } from './types.ts'

/**
 * 协商临时工作区（协议 §3 定案，文档一 §3.4）：项目外
 * {storageRoot}/{conversationId}/{taskId}/{Main|B|C}/，按需复制文件实验。
 * 任务结束保留（scratch_artifacts 追溯），对话结束清理整个 conversation 目录。
 */
export interface TaskScratch {
  taskDir: string
  agentDirs: Record<ConsensusAgentId, string>
}

export async function createTaskScratch(
  storageRoot: string,
  conversationId: string,
  taskId: string,
): Promise<TaskScratch> {
  const taskDir = join(storageRoot, conversationId, taskId)
  const agentDirs = {
    Main: join(taskDir, 'Main'),
    B: join(taskDir, 'B'),
    C: join(taskDir, 'C'),
  } satisfies Record<ConsensusAgentId, string>
  // 目录必须先存在：权限引擎的边界检查走 realpath，不存在的目录会被判越界
  await Promise.all(Object.values(agentDirs).map((dir) => mkdir(dir, { recursive: true })))
  return { taskDir, agentDirs }
}

/** 对话结束时清理该对话的全部任务 scratch；调用方决定是否允许降级为尽力清理。 */
export async function cleanupConversationScratch(
  storageRoot: string,
  conversationId: string,
): Promise<void> {
  await rm(join(storageRoot, conversationId), {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
}
