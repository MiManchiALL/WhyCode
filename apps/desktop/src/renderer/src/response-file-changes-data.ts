import type { ToolFileChange } from '@whycode/core/events'
import { useContext, useEffect, useMemo, useState } from 'react'
import { conversationSections } from '../../shared/conversation-sections.ts'
import type { Block } from '../../shared/conversation-state.ts'
import type { ConversationPresentation } from './conversation-presentation.ts'
import { MarkdownViewOwnerContext } from './markdown-view-state.ts'

type FileChangesResult =
  | { status: 'error'; message: string }
  | { status: 'ready'; changes: ToolFileChange[] }

export interface ResponseFileChangesResult {
  checkpoints: string
  state: FileChangesResult
}

export function responseCheckpointIds(activity: readonly Block[]): string[] {
  return activity.flatMap(block => block.kind === 'tool' && block.call.checkpointId ? [block.call.checkpointId] : [])
}

async function readResponseFileChanges(runtimeId: string, checkpointIds: string[]): Promise<ResponseFileChangesResult> {
  const checkpoints = checkpointIds.join(',')
  try {
    const result = await window.whycode.checkpointFileChanges({ runtimeId, checkpointIds })
    return { checkpoints, state: result.ok ? { status: 'ready', changes: result.changes } : { status: 'error', message: result.error } }
  } catch (error) {
    return { checkpoints, state: { status: 'error', message: error instanceof Error ? error.message : String(error) } }
  }
}

/** 贴底打开时，最后一张改动卡与正文一起交付。其余历史卡片仍按原流程加载。 */
export async function prepareBottomFileChanges(
  runtimeId: string, blocks: readonly Block[], presentation: ConversationPresentation | undefined,
): Promise<ResponseFileChangesResult | undefined> {
  if (presentation?.scroll?.atBottom === false) return
  const sections = conversationSections(blocks)
  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i]!
    if (section.kind !== 'completed-work' || section.duration.outcome !== 'completed'
      || !section.finalBlocks.some(block => block.kind === 'text')) continue
    const ids = responseCheckpointIds(section.activityBlocks)
    if (!ids.length) continue
    if (presentation?.fileChanges?.has(ids.join(','))) return
    return readResponseFileChanges(runtimeId, ids)
  }
}

export function useResponseFileChanges(runtimeId: string, checkpointIds: readonly string[]): FileChangesResult | { status: 'loading' } {
  const checkpoints = checkpointIds.join(',')
  const owner = useContext(MarkdownViewOwnerContext)
  const initial = useMemo((): FileChangesResult | undefined => {
    if (owner?.initialFileChanges?.checkpoints === checkpoints) return owner.initialFileChanges.state
    const changes = owner?.cache.get(owner.key)?.fileChanges?.get(checkpoints)
    return changes && { status: 'ready', changes }
  }, [owner, checkpoints])
  const [result, setResult] = useState<ResponseFileChangesResult & { runtimeId: string }>()
  useEffect(() => {
    if (!checkpoints || initial) return
    let active = true
    void readResponseFileChanges(runtimeId, checkpoints.split(',')).then(result => {
      if (!active) return
      if (result.state.status === 'ready') owner?.cache.saveFileChanges(owner.key, checkpoints, result.state.changes)
      setResult({ ...result, runtimeId })
    })
    return () => { active = false }
  }, [runtimeId, checkpoints, initial, owner])
  if (!checkpoints) return { status: 'ready', changes: [] }
  if (initial) return initial
  return result?.runtimeId === runtimeId && result.checkpoints === checkpoints ? result.state : { status: 'loading' }
}

export function totalFileChanges(changes: readonly ToolFileChange[]): { added: number; removed: number } {
  return changes.reduce((sum, change) => ({ added: sum.added + change.added, removed: sum.removed + change.removed }), { added: 0, removed: 0 })
}
