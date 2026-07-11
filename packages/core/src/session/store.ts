import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open as openFile, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ModelMessage } from 'ai'
import {
  consensusPersistedStateSchema,
  keepsConsensusProgress,
  type ConsensusPersistedState,
  type ConsensusTaskOutcome,
} from '../consensus/types.ts'
import type { StopReason } from '../events.ts'
import {
  activeTaskPlanSchema,
  type ActiveTaskPlan,
  type TaskPlanStepUpdate,
} from '../tasks/types.ts'
import { hasPendingUserQuestion } from '../tasks/answer-resume.ts'
import { viewEventSchema, type ViewEvent } from './view-events.ts'
import { buildLoadedSession, parseTranscript } from './chain.ts'
import { createTurnAbortedMessage } from './interruption.ts'
import {
  getSessionPaths,
  isSessionId,
  metadataFromStart,
  sameProject,
  validateSessionId,
  writeMetadata,
  type SessionPaths,
} from './metadata.ts'
import {
  SESSION_SCHEMA_VERSION,
  sessionEntrySchema,
  type SessionCreateInput,
  type SessionEntry,
  type SessionMetadata,
  type SessionRecorder,
} from './types.ts'

export class SessionStore {
  private readonly rootDir: string

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir)
  }

  async create(input: SessionCreateInput): Promise<SessionJournal> {
    const sessionId = randomUUID()
    const paths = this.pathsFor(sessionId)
    const timestamp = new Date().toISOString()
    const parsedStart = sessionEntrySchema.parse({
      schemaVersion: SESSION_SCHEMA_VERSION,
      type: 'session-start',
      sessionId,
      uuid: randomUUID(),
      parentUuid: null,
      timestamp,
      projectDir: input.projectDir,
      modelId: input.modelId,
    })
    if (parsedStart.type !== 'session-start') throw new Error('无法创建会话起始记录')
    const start = parsedStart
    const metadata = metadataFromStart(start)
    await mkdir(paths.sessionDir, { recursive: true, mode: 0o700 })
    await writeFile(paths.transcript, `${JSON.stringify(start)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flush: true,
    })
    await writeMetadata(paths.metadata, metadata)
    return new SessionJournal(
      paths,
      metadata,
      start.uuid,
      [],
      [],
      new Map(),
      new Map(),
      null,
      [],
      null,
      null,
      null,
      null,
      null,
      null,
    )
  }

  async open(sessionId: string): Promise<SessionJournal> {
    validateSessionId(sessionId)
    const paths = this.pathsFor(sessionId)
    const text = await readFile(paths.transcript, 'utf8')
    const entries = parseTranscript(text)
    const repairLength = validPrefixByteLengthBeforeTrailingPartialJson(text)
    if (repairLength !== null) {
      // parseTranscript 允许崩溃留下的最后半行；在 journal 继续 append 前必须物理修剪，
      // 否则 recovery snapshot 会粘在半行后并把下一次重启变成中间损坏。
      const file = await openFile(paths.transcript, 'r+')
      try {
        await file.truncate(repairLength)
        await file.sync()
      } finally {
        await file.close()
      }
    } else if (text.length > 0 && !text.endsWith('\n')) {
      // 完整 JSON 也可能在换行写入前崩溃；先补分隔符再允许后续 append，
      // 否则下一条记录会与它粘成一行并在再下次启动时一起被当作坏尾丢弃。
      const file = await openFile(paths.transcript, 'a')
      try {
        await file.write('\n')
        await file.sync()
      } finally {
        await file.close()
      }
    }
    const loaded = buildLoadedSession(entries)
    if (loaded.metadata.sessionId !== sessionId) throw new Error('会话 ID 与目录不匹配')
    const metadata = loaded.metadata
    await writeMetadata(paths.metadata, metadata)
    return new SessionJournal(
      paths,
      metadata,
      loaded.leafUuid,
      loaded.messages,
      loaded.viewEvents,
      loaded.turnStartMessages,
      loaded.turnStartTaskPlans,
      loaded.interruptedTurnId,
      loaded.undeliveredUserInputIds,
      loaded.interruptedConsensusTaskId,
      loaded.interruptedConsensusBaseMessages,
      loaded.interruptedConsensusBaseTaskPlan,
      loaded.interruptedConsensusBaseTurnIds,
      loaded.consensusState,
      loaded.activeTaskPlan,
    )
  }

  async list(
    projectDir?: string | null,
    liveSession?: SessionMetadata,
  ): Promise<SessionMetadata[]> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    const entries = await readdir(this.rootDir, { withFileTypes: true })
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.readSummary(entry.name, liveSession)),
    )
    return sessions
      .filter((item): item is SessionMetadata => Boolean(item))
      .filter((item) => projectDir === undefined || sameProject(item.projectDir, projectDir))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async delete(sessionId: string): Promise<boolean> {
    validateSessionId(sessionId)
    const paths = this.pathsFor(sessionId)
    try {
      await rm(paths.sessionDir, { recursive: true, force: false })
      return true
    } catch (error) {
      if (isNotFound(error)) return false
      throw error
    }
  }

  private async readSummary(
    sessionId: string,
    liveSession?: SessionMetadata,
  ): Promise<SessionMetadata | null> {
    if (!isSessionId(sessionId)) return null
    if (liveSession?.sessionId === sessionId) return { ...liveSession }
    try {
      return (await this.open(sessionId)).metadataSnapshot
    } catch {
      return null
    }
  }

  private pathsFor(sessionId: string): SessionPaths {
    return getSessionPaths(this.rootDir, sessionId)
  }
}

export class SessionJournal implements SessionRecorder {
  readonly sessionId: string
  private readonly paths: SessionPaths
  private metadata: SessionMetadata
  private leafUuid: string
  private messages: ModelMessage[]
  private viewEvents: ViewEvent[]
  private turnStartMessages: Map<string, ModelMessage[]>
  private turnStartTaskPlans: Map<string, ActiveTaskPlan | null>
  private activeTurnId: string | null
  private undeliveredUserInputIdSet: Set<string>
  private activeConsensusTaskId: string | null
  private activeConsensusBaseMessages: ModelMessage[] | null
  private activeConsensusBaseTaskPlan: ActiveTaskPlan | null
  private activeConsensusBaseTurnIds: Set<string> | null
  private consensusState: ConsensusPersistedState | null
  private activeTaskPlan: ActiveTaskPlan | null
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    paths: SessionPaths,
    metadata: SessionMetadata,
    leafUuid: string,
    messages: ModelMessage[],
    viewEvents: ViewEvent[],
    turnStartMessages: Map<string, ModelMessage[]>,
    turnStartTaskPlans: Map<string, ActiveTaskPlan | null>,
    interruptedTurnId: string | null,
    undeliveredUserInputIds: string[],
    interruptedConsensusTaskId: string | null,
    interruptedConsensusBaseMessages: ModelMessage[] | null,
    interruptedConsensusBaseTaskPlan: ActiveTaskPlan | null,
    interruptedConsensusBaseTurnIds: string[] | null,
    consensusState: ConsensusPersistedState | null,
    activeTaskPlan: ActiveTaskPlan | null,
  ) {
    this.paths = paths
    this.metadata = metadata
    this.sessionId = metadata.sessionId
    this.leafUuid = leafUuid
    this.messages = [...messages]
    this.viewEvents = [...viewEvents]
    this.turnStartMessages = new Map(
      [...turnStartMessages].map(([turnId, messages]) => [turnId, structuredClone(messages)]),
    )
    this.turnStartTaskPlans = new Map(
      [...turnStartTaskPlans].map(([turnId, plan]) => [turnId, structuredClone(plan)]),
    )
    this.activeTurnId = interruptedTurnId
    this.undeliveredUserInputIdSet = new Set(undeliveredUserInputIds)
    this.activeConsensusTaskId = interruptedConsensusTaskId
    this.activeConsensusBaseMessages = interruptedConsensusBaseMessages
    this.activeConsensusBaseTaskPlan = interruptedConsensusBaseTaskPlan
    this.activeConsensusBaseTurnIds = interruptedConsensusBaseTurnIds
      ? new Set(interruptedConsensusBaseTurnIds)
      : null
    this.consensusState = consensusState
    this.activeTaskPlan = activeTaskPlan
  }

  get initialMessages(): readonly ModelMessage[] {
    return this.messages
  }

  get checkpointDirectory(): string {
    return this.paths.checkpoints
  }

  messagesBeforeTurn(turnId: string): ModelMessage[] | null {
    const messages = this.turnStartMessages.get(turnId)
    if (
      !messages
      || messages.length >= this.messages.length
      || !isMessagePrefix(messages, this.messages)
    ) return null
    return structuredClone(messages)
  }

  taskPlanBeforeTurn(turnId: string): ActiveTaskPlan | null | undefined {
    const messages = this.turnStartMessages.get(turnId)
    if (
      !messages
      || messages.length >= this.messages.length
      || !isMessagePrefix(messages, this.messages)
      || !this.turnStartTaskPlans.has(turnId)
    ) return undefined
    return structuredClone(this.turnStartTaskPlans.get(turnId) ?? null)
  }

  get initialViewEvents(): readonly ViewEvent[] {
    return this.viewEvents
  }

  get interruptedTurnId(): string | null {
    return this.activeTurnId
  }

  get undeliveredUserInputIds(): readonly string[] {
    return [...this.undeliveredUserInputIdSet]
  }

  get interruptedConsensusTaskId(): string | null {
    return this.activeConsensusTaskId
  }

  get initialConsensusState(): ConsensusPersistedState | null {
    return this.consensusState ? consensusPersistedStateSchema.parse(this.consensusState) : null
  }

  get initialTaskPlan(): ActiveTaskPlan | null {
    return this.activeTaskPlan
      ? activeTaskPlanSchema.parse(structuredClone(this.activeTaskPlan))
      : null
  }

  get metadataSnapshot(): SessionMetadata {
    return { ...this.metadata }
  }

  recordUserInput(text: string, startsTurn: boolean): Promise<void> {
    return this.enqueue(async () => {
      const input = this.entry({ type: 'user-input', text, startsTurn })
      await this.appendEntries([input])
      if (input.type === 'user-input' && input.startsTurn) {
        this.undeliveredUserInputIdSet.add(input.uuid)
        this.viewEvents.push({ type: 'user-message', text: input.text, startsTurn: true })
      }
      const clipped = clip(text)
      this.metadata.lastUserText = clipped
      if (!this.metadata.title) this.metadata.title = clipped
      this.metadata.updatedAt = input.timestamp
      if (input.type === 'user-input' && input.startsTurn) {
        this.metadata.status = 'interrupted'
      }
      await writeMetadata(this.paths.metadata, this.metadata)
    })
  }

  recordViewEvents(events: ViewEvent[]): Promise<void> {
    if (events.length === 0) return Promise.resolve()
    const parsed = events.map((event) => viewEventSchema.parse(event))
    return this.enqueue(async () => {
      const entry = this.entry({ type: 'view-events', events: parsed })
      await this.appendEntries([entry])
      this.viewEvents.push(...parsed)
    })
  }

  recordTurnStart(turnId: string, messages: ModelMessage[]): Promise<void> {
    return this.enqueue(async () => {
      const parentUuid = this.leafUuid
      this.turnStartMessages.set(turnId, structuredClone(this.messages))
      this.turnStartTaskPlans.set(turnId, structuredClone(this.activeTaskPlan))
      const started = this.entry({ type: 'turn-start', turnId })
      const batch = this.entry({ type: 'messages', turnId, messages }, started.uuid)
      await this.appendEntries([started, batch])
      this.undeliveredUserInputIdSet.delete(parentUuid)
      this.messages.push(...messages)
      this.activeTurnId = turnId
      this.metadata.updatedAt = started.timestamp
      this.metadata.status = 'running'
      await writeMetadata(this.paths.metadata, this.metadata)
    })
  }

  recordStep(
    turnId: string,
    messages: ModelMessage[],
    taskPlan?: TaskPlanStepUpdate,
  ): Promise<void> {
    return this.enqueue(async () => {
      const batch = this.entry({ type: 'messages', turnId, messages })
      const entries: SessionEntry[] = [batch]
      if (taskPlan !== undefined) {
        entries.push(this.entry({ type: 'task-state', activePlan: taskPlan }, batch.uuid))
      }
      await this.appendEntries(entries)
      this.messages.push(...messages)
      if (taskPlan !== undefined) this.activeTaskPlan = structuredClone(taskPlan)
      this.metadata.updatedAt = batch.timestamp
      await writeMetadata(this.paths.metadata, this.metadata)
    })
  }

  recordTurnEnd(turnId: string, stopReason: StopReason): Promise<void> {
    return this.enqueue(async () => {
      const ended = this.entry({ type: 'turn-end', turnId, stopReason })
      await this.appendEntries([ended])
      if (this.activeTurnId === turnId) this.activeTurnId = null
      this.metadata.updatedAt = ended.timestamp
      this.metadata.status =
        stopReason === 'error'
          ? 'error'
          : this.activeConsensusTaskId
            ? 'running'
            : this.undeliveredUserInputIdSet.size > 0
              ? 'interrupted'
              : stopReason === 'waiting-user'
                ? 'waiting-user'
                : stopReason === 'paused'
                  ? 'paused'
                  : stopReason === 'max-turns'
                    ? 'max-turns'
                    : 'idle'
      await writeMetadata(this.paths.metadata, this.metadata)
    })
  }

  recordSnapshot(
    reason: 'compact' | 'rollback',
    messages: ModelMessage[],
    activeTurnId?: string,
    taskPlan?: ActiveTaskPlan | null,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.undeliveredUserInputIdSet.size > 0) {
        throw new Error('存在尚未交付给模型的用户输入，不能建立会话快照')
      }
      const snapshot = this.entry(
        {
          type: 'snapshot',
          reason,
          activeTurnId: activeTurnId ?? null,
          activeConsensusTaskId: this.activeConsensusTaskId,
          activeConsensusBaseMessages: this.activeConsensusBaseMessages,
          activeConsensusBaseTaskPlan: this.activeConsensusBaseTaskPlan,
          activeConsensusBaseTurnIds: this.activeConsensusBaseTurnIds
            ? [...this.activeConsensusBaseTurnIds]
            : null,
          consensusState: this.consensusState,
          taskPlan: taskPlan === undefined ? this.activeTaskPlan : taskPlan,
          modelId: this.metadata.modelId,
          messages,
          turnStartMessages: reason === 'rollback'
            ? this.turnStartsWithin(messages)
            : [],
        },
        null,
      )
      await this.appendEntries([snapshot])
      this.messages = [...messages]
      this.activeTaskPlan = snapshot.type === 'snapshot' ? snapshot.taskPlan : null
      this.undeliveredUserInputIdSet.clear()
      this.activeConsensusBaseTurnIds = snapshot.type === 'snapshot'
        && snapshot.activeConsensusBaseTurnIds
        ? new Set(snapshot.activeConsensusBaseTurnIds)
        : null
      this.turnStartMessages = new Map(
        (snapshot.type === 'snapshot' ? snapshot.turnStartMessages : [])
          .map((start) => [start.turnId, structuredClone(start.messages)]),
      )
      this.turnStartTaskPlans = new Map(
        (snapshot.type === 'snapshot' ? snapshot.turnStartMessages : [])
          .map((start) => [start.turnId, structuredClone(start.taskPlan)]),
      )
      this.activeTurnId = activeTurnId ?? null
      this.metadata.updatedAt = snapshot.timestamp
      if (reason === 'rollback') {
        this.metadata.status = this.activeTurnId || this.activeConsensusTaskId
          ? 'running'
          : hasPendingUserQuestion(messages)
            ? 'waiting-user'
            : 'idle'
      }
      await writeMetadata(this.paths.metadata, this.metadata)
    })
  }

  recordConsensusTaskStart(
    taskId: string,
    state: ConsensusPersistedState,
    userText: string,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (this.activeConsensusTaskId) {
        throw new Error(`共识任务 ${this.activeConsensusTaskId} 尚未结束`)
      }
      const parentUuid = this.leafUuid
      const baseTurnIds = [...this.turnStartMessages.keys()]
      const started = this.entry({
        type: 'consensus-task-start',
        taskId,
        state,
        baseTaskPlan: this.activeTaskPlan,
        userText,
        baseTurnIds,
      })
      if (started.type !== 'consensus-task-start') throw new Error('无法写入共识任务起点')
      await this.appendEntries([started])
      this.undeliveredUserInputIdSet.delete(parentUuid)
      this.activeConsensusTaskId = taskId
      this.activeConsensusBaseMessages = [
        ...this.messages,
        { role: 'user', content: userText },
      ]
      this.activeConsensusBaseTaskPlan = structuredClone(this.activeTaskPlan)
      this.activeConsensusBaseTurnIds = new Set(started.baseTurnIds)
      this.consensusState = started.state
      this.metadata.updatedAt = started.timestamp
      this.metadata.status = 'running'
      await writeMetadata(this.paths.metadata, this.metadata)
    })
  }

  recordConsensusTaskEnd(
    taskId: string,
    outcome: ConsensusTaskOutcome,
    state: ConsensusPersistedState,
  ): Promise<void> {
    return this.enqueue(async () => {
      if (
        this.activeConsensusTaskId !== taskId
        || !this.activeConsensusBaseMessages
        || !this.activeConsensusBaseTurnIds
      ) {
        throw new Error(`共识任务 ${taskId} 没有匹配的活动起点`)
      }
      const rollbackMessages = keepsConsensusProgress(outcome)
        ? null
        : [
            ...this.activeConsensusBaseMessages,
            createTurnAbortedMessage(
              outcome === 'aborted' ? 'user-cancel' : 'consensus-failure',
            ),
          ]
      const taskPlan = keepsConsensusProgress(outcome)
        ? this.activeTaskPlan
        : this.activeConsensusBaseTaskPlan
      const ended = this.entry({
        type: 'consensus-task-end',
        taskId,
        outcome,
        state,
        rollbackMessages,
        taskPlan,
      })
      if (ended.type !== 'consensus-task-end') throw new Error('无法写入共识任务终点')
      await this.appendEntries([ended])
      if (ended.rollbackMessages) {
        this.messages = [...ended.rollbackMessages]
        this.retainTurnStarts(this.activeConsensusBaseTurnIds)
      }
      this.activeTaskPlan = structuredClone(ended.taskPlan)
      if (this.activeConsensusTaskId === taskId) this.activeConsensusTaskId = null
      this.activeConsensusBaseMessages = null
      this.activeConsensusBaseTaskPlan = null
      this.activeConsensusBaseTurnIds = null
      this.consensusState = ended.state
      this.metadata.updatedAt = ended.timestamp
      this.metadata.status =
        outcome === 'error'
          ? 'error'
          : this.activeTurnId
            ? 'running'
            : this.undeliveredUserInputIdSet.size > 0
              ? 'interrupted'
              : outcome === 'paused'
                ? 'paused'
                : outcome === 'max-turns'
                  ? 'max-turns'
                  : 'idle'
      await writeMetadata(this.paths.metadata, this.metadata)
    })
  }

  /** 用户显式恢复时切断崩溃留下的活动边界；旧记录保留在 JSONL 中但不再进入活动父链。 */
  recoverInterruptedWork(): Promise<void> {
    return this.enqueue(async () => {
      if (
        !this.activeTurnId
        && !this.activeConsensusTaskId
        && this.undeliveredUserInputIdSet.size === 0
      ) return
      const recoveredMessages = [
        ...this.messages,
        createTurnAbortedMessage('process-interruption'),
      ]
      const recoverableTurnIds = this.activeConsensusTaskId
        ? this.activeConsensusBaseTurnIds ?? new Set<string>()
        : undefined
      const recovered = this.entry(
        {
          type: 'snapshot',
          reason: 'recovery',
          activeTurnId: null,
          activeConsensusTaskId: null,
          activeConsensusBaseMessages: null,
          activeConsensusBaseTaskPlan: null,
          activeConsensusBaseTurnIds: null,
          consensusState: this.consensusState,
          taskPlan: this.activeTaskPlan,
          modelId: this.metadata.modelId,
          messages: recoveredMessages,
          turnStartMessages: this.turnStartsWithin(recoveredMessages, recoverableTurnIds),
        },
        null,
      )
      await this.appendEntries([recovered])
      this.messages = [...recoveredMessages]
      this.activeTurnId = null
      this.undeliveredUserInputIdSet.clear()
      this.activeConsensusTaskId = null
      this.activeConsensusBaseMessages = null
      this.activeConsensusBaseTaskPlan = null
      this.activeConsensusBaseTurnIds = null
      this.metadata.updatedAt = recovered.timestamp
      this.metadata.status = hasPendingUserQuestion(recoveredMessages) ? 'waiting-user' : 'idle'
      this.turnStartMessages = new Map(
        (recovered.type === 'snapshot' ? recovered.turnStartMessages : [])
          .map((start) => [start.turnId, structuredClone(start.messages)]),
      )
      this.turnStartTaskPlans = new Map(
        (recovered.type === 'snapshot' ? recovered.turnStartMessages : [])
          .map((start) => [start.turnId, structuredClone(start.taskPlan)]),
      )
      await writeMetadata(this.paths.metadata, this.metadata)
    })
  }

  updateModel(modelId: string): Promise<void> {
    return this.enqueue(async () => {
      if (modelId === this.metadata.modelId) return
      const changed = this.entry({ type: 'model-change', modelId })
      await this.appendEntries([changed])
      this.metadata.modelId = modelId
      this.metadata.updatedAt = changed.timestamp
      await writeMetadata(this.paths.metadata, this.metadata)
    })
  }

  private entry(
    value: Record<string, unknown>,
    parentUuid: string | null = this.leafUuid,
  ): SessionEntry {
    return sessionEntrySchema.parse({
      schemaVersion: SESSION_SCHEMA_VERSION,
      sessionId: this.sessionId,
      uuid: randomUUID(),
      parentUuid,
      timestamp: new Date().toISOString(),
      ...value,
    })
  }

  private turnStartsWithin(messages: ModelMessage[], allowedTurnIds?: ReadonlySet<string>): {
    turnId: string
    messages: ModelMessage[]
    taskPlan: ActiveTaskPlan | null
  }[] {
    return [...this.turnStartMessages]
      .filter(([turnId, start]) =>
        (allowedTurnIds === undefined || allowedTurnIds.has(turnId))
        && start.length < messages.length
        && isMessagePrefix(start, messages))
      .map(([turnId, start]) => ({
        turnId,
        messages: structuredClone(start),
        taskPlan: structuredClone(this.turnStartTaskPlans.get(turnId) ?? null),
      }))
  }

  private retainTurnStarts(turnIds: ReadonlySet<string>): void {
    this.turnStartMessages = new Map(
      [...this.turnStartMessages].filter(([turnId]) => turnIds.has(turnId)),
    )
    this.turnStartTaskPlans = new Map(
      [...this.turnStartTaskPlans].filter(([turnId]) => turnIds.has(turnId)),
    )
  }

  private async appendEntries(entries: SessionEntry[]): Promise<void> {
    const text = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    await appendFile(this.paths.transcript, text, { encoding: 'utf8', flush: true })
    this.leafUuid = entries.at(-1)!.uuid
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(operation)
    this.writeQueue = next.catch(() => {})
    return next
  }
}

function isMessagePrefix(prefix: ModelMessage[], messages: ModelMessage[]): boolean {
  if (prefix.length > messages.length) return false
  return prefix.every((message, index) =>
    JSON.stringify(message) === JSON.stringify(messages[index]),
  )
}

function clip(text: string): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

function validPrefixByteLengthBeforeTrailingPartialJson(text: string): number | null {
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.trim()
    if (!line) continue
    try {
      JSON.parse(line)
      return null
    } catch {
      const prefixCharacters = lines
        .slice(0, index)
        .reduce((total, entry) => total + entry.length + 1, 0)
      return Buffer.byteLength(text.slice(0, prefixCharacters), 'utf8')
    }
  }
  return null
}
