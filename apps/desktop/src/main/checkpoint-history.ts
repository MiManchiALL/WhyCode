import {
  CheckpointManager,
  type CheckpointFileChangesResult,
  type CheckpointFileCurrentMatchResult,
  type CheckpointFilePreviewResult,
} from '@whycode/core'
import type { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { sep } from 'node:path'
import { pathKey } from './workspace-path.ts'

// 历史快照归持久会话所有；模型连接不可用时也必须能读取，不能借此初始化 Agent。
function checkpointsFor(runtime: DesktopSessionRuntime | null): CheckpointManager {
  if (!runtime?.journal || runtime.isDisposed) throw new Error('当前会话记录不可用')
  const journal = runtime.journal
  return new CheckpointManager({ sessionId: journal.sessionId, sessionDir: journal.checkpointDirectory })
}

export async function readCheckpointFileChanges(
  runtime: DesktopSessionRuntime | null,
  checkpointIds: readonly string[],
  scratchRootDirectory: string,
): Promise<CheckpointFileChangesResult> {
  try {
    const changes = await checkpointsFor(runtime).fileChanges(checkpointIds)
    const scratchPrefix = `${pathKey(scratchRootDirectory)}${sep}`
    changes.sort((left, right) => Number(pathKey(left.path).startsWith(scratchPrefix))
      - Number(pathKey(right.path).startsWith(scratchPrefix)))
    return { ok: true, changes }
  } catch (error) {
    return { ok: false, error: `文件改动读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function readCheckpointFilePreview(
  runtime: DesktopSessionRuntime | null,
  target: string | readonly string[],
  path: string,
): Promise<CheckpointFilePreviewResult> {
  try {
    const preview = await checkpointsFor(runtime).filePreview(target, path)
    return preview
      ? { ok: true, preview }
      : { ok: false, error: '所选检查点没有对应的文件快照' }
  } catch (error) {
    return { ok: false, error: `文件预览读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

export async function checkCheckpointFileCurrentMatch(
  runtime: DesktopSessionRuntime | null,
  toolUseId: string,
  path: string,
): Promise<CheckpointFileCurrentMatchResult> {
  try {
    const matches = await checkpointsFor(runtime).filePreviewMatchesCurrent(toolUseId, path)
    return matches === null
      ? { ok: false, error: '该工具调用没有对应的文件快照' }
      : { ok: true, matches }
  } catch (error) {
    return { ok: false, error: `当前文件校验失败：${error instanceof Error ? error.message : String(error)}` }
  }
}
