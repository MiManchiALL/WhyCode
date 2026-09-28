import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ModelMessage } from 'ai'
import type { ImageAttachment } from '../attachments/types.ts'
import type { PdfAttachment } from '../pdf/types.ts'
import { clearMcpProjectTrust } from '../mcp/state.ts'
import type { WorkspaceBinding } from '../workspace/types.ts'
import { buildLoadedSession } from './chain.ts'
import { copyForkAttachments, copyForkCheckpoints, forkScratchPathMapper, type ForkScratchCopy } from './fork-resources.ts'
import { forkFileReferences } from './fork-file-references.ts'
import { getSessionPaths, writeMetadata, type SessionPaths } from './metadata.ts'
import {
  SESSION_SCHEMA_VERSION,
  sessionEntrySchema,
  type LoadedSession,
  type PendingUserInput,
  type SessionEntry,
  type SessionForkOrigin,
} from './types.ts'
import type { ViewEvent } from './view-events.ts'

interface CreateSessionForkInput {
  rootDir: string
  sourcePaths: SessionPaths
  sourceEntries: SessionEntry[]
  sourceTurnId: string
  targetSessionId: string
  title: string
  origin: SessionForkOrigin
  scratchCopy?: ForkScratchCopy
}

export async function createSessionFork(
  input: CreateSessionForkInput,
): Promise<LoadedSession> {
  const sourcePrefix = withoutPendingInputs(
    forkPrefix(input.sourceEntries, input.sourceTurnId),
  )
  const sourceWorkspace = buildLoadedSession(sourcePrefix).metadata.workspace
  const rebase = forkScratchPathMapper(input.scratchCopy, sourceWorkspace.mode === 'ssh' ? path.posix : path)
  const presentations = forkFileReferences(rebase)
  const entries = sourcePrefix.map((entry) =>
    rehomeEntry(
      entry,
      input.targetSessionId,
      input.title,
      input.origin,
      sourceWorkspace,
      presentations,
    ))
  const loaded = buildLoadedSession(entries)

  const targetPaths = getSessionPaths(input.rootDir, input.targetSessionId)
  const stagingPaths = getSessionPaths(input.rootDir, `.fork-${input.targetSessionId}`)
  await rm(stagingPaths.sessionDir, { recursive: true, force: true })
  await mkdir(stagingPaths.sessionDir, { recursive: false, mode: 0o700 })
  try {
    await writeFile(
      stagingPaths.transcript,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      { encoding: 'utf8', mode: 0o600, flush: true },
    )
    await writeMetadata(stagingPaths.metadata, loaded.metadata)
    await copyForkAttachments(input.sourcePaths, stagingPaths, loaded)
    await copyForkCheckpoints(
      input.sourcePaths,
      stagingPaths,
      entries,
      input.targetSessionId,
      rebase,
    )
    await rename(stagingPaths.sessionDir, targetPaths.sessionDir)
    return loaded
  } catch (error) {
    await rm(stagingPaths.sessionDir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

function forkPrefix(entries: readonly SessionEntry[], sourceTurnId: string): SessionEntry[] {
  const matchingEnds = entries.flatMap((entry, index) =>
    entry.type === 'turn-end' && entry.turnId === sourceTurnId ? [index] : [])
  if (matchingEnds.length !== 1) throw new Error('找不到唯一的模型回复边界')
  const turnEndIndex = matchingEnds[0]!
  const selectedEnd = entries[turnEndIndex]!
  if (
    selectedEnd.type !== 'turn-end'
    || selectedEnd.stopReason !== 'completed'
  ) {
    throw new Error('只能从完整结束的模型回复创建分支')
  }
  const finalStep = entries.slice(0, turnEndIndex).findLast((entry) =>
    entry.type === 'messages' && entry.turnId === sourceTurnId)
  if (
    finalStep?.type !== 'messages'
    || !finalStep.messages.some(hasAssistantText)
    || finalStep.messages.some(hasAssistantToolCall)
  ) {
    throw new Error('只能从包含最终文本的完整模型回复创建分支')
  }

  let boundary: { entryIndex: number; eventIndex: number } | null = null
  for (let index = turnEndIndex + 1; index < entries.length; index++) {
    const entry = entries[index]!
    if (entry.type === 'user-input' && entry.startsTurn) break
    if (entry.type !== 'view-events') continue
    const eventIndex = entry.events.findIndex((event) =>
      isForkBoundaryEvent(event, sourceTurnId))
    if (eventIndex >= 0) {
      boundary = { entryIndex: index, eventIndex }
      break
    }
  }
  if (!boundary) {
    throw new Error('所选回复不是完整对话的 Fork 边界')
  }

  const boundaryEntry = entries[boundary.entryIndex]!
  if (boundaryEntry.type !== 'view-events') throw new Error('Fork 边界记录类型无效')
  const prefix = entries.slice(0, boundary.entryIndex)
  prefix.push(sessionEntrySchema.parse({
    ...boundaryEntry,
    events: boundaryEntry.events.slice(0, boundary.eventIndex + 1),
  }))
  const loaded = buildLoadedSession(prefix)
  if (loaded.metadata.status !== 'idle') {
    throw new Error('模型回复之后仍有未完成的会话事务，不能创建分支')
  }
  return prefix
}

function isForkBoundaryEvent(event: ViewEvent, sourceTurnId: string): boolean {
  return event.type === 'core-event'
    && event.event.type === 'work-finished'
    && event.event.outcome === 'completed'
    && event.event.forkTurnId === sourceTurnId
}

function hasAssistantText(message: ModelMessage): boolean {
  if (message.role !== 'assistant') return false
  if (typeof message.content === 'string') return message.content.trim().length > 0
  return message.content.some((part) =>
    part.type === 'text' && part.text.trim().length > 0)
}

function hasAssistantToolCall(message: ModelMessage): boolean {
  return message.role === 'assistant'
    && Array.isArray(message.content)
    && message.content.some((part) => part.type === 'tool-call')
}

function rehomeEntry(
  entry: SessionEntry,
  sessionId: string,
  title: string,
  origin: SessionForkOrigin,
  workspace: WorkspaceBinding,
  presentations: ReturnType<typeof forkFileReferences>,
): SessionEntry {
  const common = { ...entry, schemaVersion: SESSION_SCHEMA_VERSION, sessionId }
  switch (entry.type) {
    case 'session-start':
      return sessionEntrySchema.parse({ ...common, workspace, title, forkOrigin: origin })
    case 'user-input':
      return sessionEntrySchema.parse({
        ...common,
        ...(entry.attachments
          ? { attachments: entry.attachments.map((value) => rehomeImage(value, sessionId)) }
          : {}),
        ...(entry.pdfAttachments
          ? { pdfAttachments: entry.pdfAttachments.map((value) => rehomePdf(value, sessionId)) }
          : {}),
      })
    case 'btw-input':
      return sessionEntrySchema.parse({
        ...common,
        ...(entry.attachments
          ? { attachments: entry.attachments.map((value) => rehomeImage(value, sessionId)) }
          : {}),
      })
    case 'btw-response':
      return sessionEntrySchema.parse({
        ...common,
        ...(entry.toolSteps ? {
          toolSteps: entry.toolSteps.map((step) => ({
            ...step,
            messages: presentations.messages(step.messages),
            ...(step.pdfAttachments ? {
              pdfAttachments: step.pdfAttachments.map((value) => rehomePdf(value, sessionId)),
            } : {}),
          })),
        } : {}),
      })
    case 'messages':
      return sessionEntrySchema.parse({
        ...common,
        messages: clearMcpProjectTrust(presentations.messages(entry.messages)),
        ...(entry.attachments
          ? { attachments: entry.attachments.map((value) => rehomeImage(value, sessionId)) }
          : {}),
        ...(entry.pdfAttachments
          ? { pdfAttachments: entry.pdfAttachments.map((value) => rehomePdf(value, sessionId)) }
          : {}),
      })
    case 'consensus-task-end':
      return sessionEntrySchema.parse({
        ...common,
        rollbackMessages: entry.rollbackMessages
          ? clearMcpProjectTrust(presentations.messages(entry.rollbackMessages))
          : null,
      })
    case 'snapshot':
      return sessionEntrySchema.parse({
        ...common,
        messages: clearMcpProjectTrust(presentations.messages(entry.messages)),
        pendingUserInputs: entry.pendingUserInputs.map((input) =>
          rehomePendingInput(input, sessionId)),
        activeConsensusBaseMessages: entry.activeConsensusBaseMessages
          ? clearMcpProjectTrust(presentations.messages(entry.activeConsensusBaseMessages))
          : null,
        turnStartMessages: entry.turnStartMessages.map((start) => ({
          ...start,
          messages: clearMcpProjectTrust(presentations.messages(start.messages)),
        })),
      })
    case 'view-events':
      return sessionEntrySchema.parse({
        ...common,
        events: entry.events.map((event) => rehomeViewEvent(presentations.view(event), sessionId)),
      })
    default:
      return sessionEntrySchema.parse(common)
  }
}

/**
 * 恢复草稿与未送达 steering 从未进入模型上下文，不属于 Fork。保留已经被后续
 * 根输入消费的历史身份，否则会破坏当前 schema 的原子消费校验。
 */
function withoutPendingInputs(entries: SessionEntry[]): SessionEntry[] {
  const pendingIds = new Set(
    buildLoadedSession(entries).pendingUserInputs.map((input) => input.id),
  )
  if (pendingIds.size === 0) return entries

  const redirectedParents = new Map<string, string | null>()
  const resolveParent = (parentUuid: string | null): string | null => {
    let current = parentUuid
    while (current && redirectedParents.has(current)) {
      current = redirectedParents.get(current) ?? null
    }
    return current
  }
  const retained: SessionEntry[] = []
  for (const entry of entries) {
    const parentUuid = resolveParent(entry.parentUuid)
    if (entry.type === 'user-input' && pendingIds.has(entry.uuid)) {
      redirectedParents.set(entry.uuid, parentUuid)
      continue
    }
    if (entry.type === 'user-input-restored') {
      const inputIds = entry.inputIds.filter((inputId) => !pendingIds.has(inputId))
      if (inputIds.length === 0) {
        redirectedParents.set(entry.uuid, parentUuid)
        continue
      }
      retained.push(sessionEntrySchema.parse({ ...entry, parentUuid, inputIds }))
      continue
    }
    if (entry.type === 'snapshot') {
      retained.push(sessionEntrySchema.parse({
        ...entry,
        parentUuid,
        pendingUserInputs: entry.pendingUserInputs.filter((input) => !pendingIds.has(input.id)),
      }))
      continue
    }
    retained.push(sessionEntrySchema.parse({ ...entry, parentUuid }))
  }
  return retained
}

function rehomeViewEvent(event: ViewEvent, sessionId: string): ViewEvent {
  if (event.type === 'user-message') {
    return {
      ...event,
      ...(event.attachments
        ? { attachments: event.attachments.map((value) => rehomeImage(value, sessionId)) }
        : {}),
      ...(event.pdfAttachments
        ? { pdfAttachments: event.pdfAttachments.map((value) => rehomePdf(value, sessionId)) }
        : {}),
    }
  }
  if (event.event.type !== 'image-viewed') return structuredClone(event)
  return {
    type: 'core-event',
    event: {
      ...event.event,
      attachments: event.event.attachments.map((value) => rehomeImage(value, sessionId)),
    },
  }
}

function rehomeImage(value: ImageAttachment, sessionId: string): ImageAttachment {
  return { ...value, sessionId }
}

function rehomePdf(value: PdfAttachment, sessionId: string): PdfAttachment {
  return { ...value, sessionId }
}

function rehomePendingInput(
  input: PendingUserInput,
  sessionId: string,
): PendingUserInput {
  return {
    ...input,
    ...(input.attachments
      ? { attachments: input.attachments.map((value) => rehomeImage(value, sessionId)) }
      : {}),
    ...(input.pdfAttachments
      ? { pdfAttachments: input.pdfAttachments.map((value) => rehomePdf(value, sessionId)) }
      : {}),
  }
}
