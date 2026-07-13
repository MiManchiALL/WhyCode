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
  cloneTaskPlanState,
  emptyTaskPlanState,
  interruptTaskPlanState,
  type TaskPlanState,
  type TaskPlanStepUpdate,
} from '../tasks/types.ts'
import { createTaskContextMessage } from '../tasks/context.ts'
import { hasPendingUserQuestion } from '../tasks/answer-resume.ts'
import { viewEventSchema, type ViewEvent } from './view-events.ts'
import { buildLoadedSession, parseTranscript } from './chain.ts'
import { createTurnAbortedMessage } from './interruption.ts'
import {
  getSessionPaths,
  getSessionDeletionMarkersDir,
  hasSessionDeletionMarker,
  isSessionId,
  metadataFromStart,
  resumableSessionSummary,
  sameProject,
  SESSION_DELETION_PENDING_REASON,
  unavailableSessionSummary,
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
  type SessionSummary,
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
      null,
      [],
      null,
      null,
      null,
      null,
      null,
      emptyTaskPlanState(),
    )
  }

  async open(sessionId: string): Promise<SessionJournal> {
    validateSessionId(sessionId)
    const paths = this.pathsFor(sessionId)
    if (await hasSessionDeletionMarker(paths)) {
      throw new Error(SESSION_DELETION_PENDING_REASON)
    }
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
      loaded.turnStartTaskStates,
      loaded.interruptedTurnId,
      loaded.interruptedTurnEngagedPlanId,
      loaded.undeliveredUserInputIds,
      loaded.interruptedConsensusTaskId,
      loaded.interruptedConsensusBaseMessages,
      loaded.interruptedConsensusBaseTaskState,
      loaded.interruptedConsensusBaseTurnIds,
      loaded.consensusState,
      loaded.taskState,
    )
  }

  async list(
    projectDir?: string | null,
    liveSession?: SessionMetadata,
  ): Promise<SessionSummary[]> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 })
    const entries = await readdir(this.rootDir, { withFileTypes: true })
    const markerEntries = await readdir(getSessionDeletionMarkersDir(this.rootDir), {
      withFileTypes: true,
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const sessionIds = new Set([
      ...entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      ...markerEntries.map((entry) => entry.name),
    ].filter(isSessionId))
    const sessions = await Promise.all(
      [...sessionIds].map((sessionId) => this.readSummary(sessionId, liveSession)),
    )
    return sessions
      .filter((item): item is SessionSummary => Boolean(item))
      .filter((item) =>
        projectDir === undefined
        || (item.projectDir !== undefined && sameProject(item.projectDir, projectDir)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async delete(sessionId: string): Promise<boolean> {
    validateSessionId(sessionId)
    const paths = this.pathsFor(sessionId)
    const deletionMarked = await hasSessionDeletionMarker(paths)
    let sessionExisted = true
    try {
      await rm(paths.sessionDir, {
        recursive: true,
        force: false,
        maxRetries: 5,
        retryDelay: 100,
      })
    } catch (error) {
      if (!isNotFound(error)) throw error
      sessionExisted = false
    }
    if (!sessionExisted && !deletionMarked) return false
    // 会话目录已经完整消失后才移除外置 marker；marker 删除失败会继续作为重试入口。
    await rm(paths.deletionMarker, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
    return true
  }

  async markDeleting(sessionId: string): Promise<boolean> {
    validateSessionId(sessionId)
    const paths = this.pathsFor(sessionId)
    if (await hasSessionDeletionMarker(paths)) return true
    try {
      await readdir(paths.sessionDir)
    } catch (error) {
      if (isNotFound(error)) return false
      throw error
    }
    await mkdir(paths.deletionMarkersDir, { recursive: true, mode: 0o700 })
    try {
      await writeFile(paths.deletionMarker, '', {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
        flush: true,
      })
      return true
    } catch (error) {
      if (isAlreadyExists(error)) return true
      if (isNotFound(error)) return false
      throw error
    }
  }

  private async readSummary(
    sessionId: string,
    liveSession?: SessionMetadata,
  ): Promise<SessionSummary | null> {
    if (!isSessionId(sessionId)) return null
    const paths = this.pathsFor(sessionId)
    const deletionMarked = await hasSessionDeletionMarker(paths).catch(() => null)
    if (deletionMarked) {
      return unavailableSessionSummary(paths, sessionId, SESSION_DELETION_PENDING_REASON)
    }
    if (deletionMarked === null) return unavailableSessionSummary(paths, sessionId)
    if (liveSession?.sessionId === sessionId) return resumableSessionSummary(liveSession)
    try {
      return resumableSessionSummary((await this.open(sessionId)).metadataSnapshot)
    } catch {
      const reason = await hasSessionDeletionMarker(paths).catch(() => false)
        ? SESSION_DELETION_PENDING_REASON
        : undefined
      return unavailableSessionSummary(paths, sessionId, reason)
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
  private turnStartTaskStates: Map<string, TaskPlanState>
  private activeTurnId: string | null
  private activeTurnEngagedPlanId: string | null
  private undeliveredUserInputIdSet: Set<string>
  private activeConsensusTaskId: string | null
  private activeConsensusBaseMessages: ModelMessage[] | null
  private activeConsensusBaseTaskState: TaskPlanState | null
  private activeConsensusBaseTurnIds: Set<string> | null
  private consensusState: ConsensusPersistedState | null
  private taskState: TaskPlanState
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    paths: SessionPaths,
    metadata: SessionMetadata,
    leafUuid: string,
    messages: ModelMessage[],
    viewEvents: ViewEvent[],
    turnStartMessages: Map<string, ModelMessage[]>,
    turnStartTaskStates: Map<string, TaskPlanState>,
    interruptedTurnId: string | null,
    interruptedTurnEngagedPlanId: string | null,
    undeliveredUserInputIds: string[],
    interruptedConsensusTaskId: string | null,
    interruptedConsensusBaseMessages: ModelMessage[] | null,
    interruptedConsensusBaseTaskState: TaskPlanState | null,
    interruptedConsensusBaseTurnIds: string[] | null,
    consensusState: ConsensusPersistedState | null,
    taskState: TaskPlanState,
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
    this.turnStartTaskStates = new Map(
      [...turnStartTaskStates].map(([turnId, state]) => [turnId, cloneTaskPlanState(state)]),
    )
    this.activeTurnId = interruptedTurnId
    this.activeTurnEngagedPlanId = interruptedTurnEngagedPlanId
    this.undeliveredUserInputIdSet = new Set(undeliveredUserInputIds)
    this.activeConsensusTaskId = interruptedConsensusTaskId
    this.activeConsensusBaseMessages = interruptedConsensusBaseMessages
    this.activeConsensusBaseTaskState = interruptedConsensusBaseTaskState
    this.activeConsensusBaseTurnIds = interruptedConsensusBaseTurnIds
      ? new Set(interruptedConsensusBaseTurnIds)
      : null
    this.consensusState = consensusState
    this.taskState = cloneTaskPlanState(taskState)
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

  taskStateBeforeTurn(turnId: string): TaskPlanState | undefined {
    const messages = this.turnStartMessages.get(turnId)
    if (
      !messages
      || messages.length >= this.messages.length
      || !isMessagePrefix(messages, this.messages)
      || !this.turnStartTaskStates.has(turnId)
    ) return undefined
    return cloneTaskPlanState(this.turnStartTaskStates.get(turnId)!)
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

  get initialTaskState(): TaskPlanState {
    return cloneTaskPlanState(this.taskState)
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

  recordTurnStart(
    turnId: string,
    messages: ModelMessage[],
    engagedPlanId?: string,
  ): Promise<void> {
    return this.enqueue(async () => {
      const parentUuid = this.leafUuid
      this.turnStartMessages.set(turnId, structuredClone(this.messages))
      this.turnStartTaskStates.set(turnId, cloneTaskPlanState(this.taskState))
      const started = this.entry({
        type: 'turn-start',
        turnId,
        engagedPlanId: engagedPlanId ?? null,
      })
      const batch = this.entry(
        { type: 'messages', turnId, messages, engagedPlanId: engagedPlanId ?? null },
        started.uuid,
      )
      await this.appendEntries([started, batch])
      this.undeliveredUserInputIdSet.delete(parentUuid)
      this.messages.push(...messages)
      this.activeTurnId = turnId
      this.activeTurnEngagedPlanId = engagedPlanId ?? null
      this.metadata.updatedAt = started.timestamp
      this.metadata.status = 'running'
      await writeMetadata(this.paths.metadata, this.metadata)
    })
  }

  recordStep(
    turnId: string,
    messages: ModelMessage[],
    taskState?: TaskPlanStepUpdate,
    engagedPlanId?: string | null,
  ): Promise<void> {
    return this.enqueue(async () => {
      const batch = this.entry({
        type: 'messages',
        turnId,
        messages,
        ...(taskState !== undefined ? { taskState } : {}),
        ...(engagedPlanId !== undefined ? { engagedPlanId } : {}),
      })
      await this.appendEntries([batch])
      this.messages.push(...messages)
      if (taskState !== undefined) this.taskState = cloneTaskPlanState(taskState)
      if (engagedPlanId !== undefined) this.activeTurnEngagedPlanId = engagedPlanId
      this.metadata.updatedAt = batch.timestamp
      await writeMetadata(this.paths.metadata, this.metadata)
    })
  }

  recordTurnEnd(turnId: string, stopReason: StopReason): Promise<void> {
    return this.enqueue(async () => {
      const ended = this.entry({ type: 'turn-end', turnId, stopReason })
      await this.appendEntries([ended])
      if (this.activeTurnId === turnId) {
        this.activeTurnId = null
        this.activeTurnEngagedPlanId = null
      }
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
    taskState?: TaskPlanState,
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
          activeTurnEngagedPlanId: activeTurnId ? this.activeTurnEngagedPlanId : null,
          activeConsensusTaskId: this.activeConsensusTaskId,
          activeConsensusBaseMessages: this.activeConsensusBaseMessages,
          activeConsensusBaseTaskState: this.activeConsensusBaseTaskState,
          activeConsensusBaseTurnIds: this.activeConsensusBaseTurnIds
            ? [...this.activeConsensusBaseTurnIds]
            : null,
          consensusState: this.consensusState,
          taskState: taskState === undefined ? this.taskState : taskState,
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
      if (snapshot.type === 'snapshot') this.taskState = cloneTaskPlanState(snapshot.taskState)
      this.undeliveredUserInputIdSet.clear()
      this.activeConsensusBaseTurnIds = snapshot.type === 'snapshot'
        && snapshot.activeConsensusBaseTurnIds
        ? new Set(snapshot.activeConsensusBaseTurnIds)
        : null
      this.turnStartMessages = new Map(
        (snapshot.type === 'snapshot' ? snapshot.turnStartMessages : [])
          .map((start) => [start.turnId, structuredClone(start.messages)]),
      )
      this.turnStartTaskStates = new Map(
        (snapshot.type === 'snapshot' ? snapshot.turnStartMessages : [])
          .map((start) => [start.turnId, cloneTaskPlanState(start.taskState)]),
      )
      this.activeTurnId = activeTurnId ?? null
      this.activeTurnEngagedPlanId = snapshot.type === 'snapshot'
        ? snapshot.activeTurnEngagedPlanId
        : null
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
        baseTaskState: this.taskState,
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
      this.activeConsensusBaseTaskState = cloneTaskPlanState(this.taskState)
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
      const taskState = keepsConsensusProgress(outcome)
        ? this.taskState
        : this.activeConsensusBaseTaskState
      if (!taskState) throw new Error('共识任务缺少起点任务状态')
      const ended = this.entry({
        type: 'consensus-task-end',
        taskId,
        outcome,
        state,
        rollbackMessages,
        taskState,
      })
      if (ended.type !== 'consensus-task-end') throw new Error('无法写入共识任务终点')
      await this.appendEntries([ended])
      if (ended.rollbackMessages) {
        this.messages = [...ended.rollbackMessages]
        this.retainTurnStarts(this.activeConsensusBaseTurnIds)
      }
      this.taskState = cloneTaskPlanState(ended.taskState)
      if (this.activeConsensusTaskId === taskId) this.activeConsensusTaskId = null
      this.activeConsensusBaseMessages = null
      this.activeConsensusBaseTaskState = null
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
      const activePlanId = this.taskState.activePlan?.id
      const interruptedExecutionWasEngaged = Boolean(
        activePlanId
        && this.activeTurnEngagedPlanId === activePlanId,
      )
      const recoveredTaskState = interruptedExecutionWasEngaged
        ? interruptTaskPlanState(this.taskState, 'process-interruption')
        : cloneTaskPlanState(this.taskState)
      const taskContext = createTaskContextMessage(recoveredTaskState)
      if (taskContext) recoveredMessages.push(taskContext)
      const recoverableTurnIds = this.activeConsensusTaskId
        ? this.activeConsensusBaseTurnIds ?? new Set<string>()
        : undefined
      const recovered = this.entry(
        {
          type: 'snapshot',
          reason: 'recovery',
          activeTurnId: null,
          activeTurnEngagedPlanId: null,
          activeConsensusTaskId: null,
          activeConsensusBaseMessages: null,
          activeConsensusBaseTaskState: null,
          activeConsensusBaseTurnIds: null,
          consensusState: this.consensusState,
          taskState: recoveredTaskState,
          modelId: this.metadata.modelId,
          messages: recoveredMessages,
          turnStartMessages: this.turnStartsWithin(recoveredMessages, recoverableTurnIds),
        },
        null,
      )
      await this.appendEntries([recovered])
      this.messages = [...recoveredMessages]
      this.taskState = recoveredTaskState
      this.activeTurnId = null
      this.activeTurnEngagedPlanId = null
      this.undeliveredUserInputIdSet.clear()
      this.activeConsensusTaskId = null
      this.activeConsensusBaseMessages = null
      this.activeConsensusBaseTaskState = null
      this.activeConsensusBaseTurnIds = null
      this.metadata.updatedAt = recovered.timestamp
      this.metadata.status = hasPendingUserQuestion(recoveredMessages) ? 'waiting-user' : 'idle'
      this.turnStartMessages = new Map(
        (recovered.type === 'snapshot' ? recovered.turnStartMessages : [])
          .map((start) => [start.turnId, structuredClone(start.messages)]),
      )
      this.turnStartTaskStates = new Map(
        (recovered.type === 'snapshot' ? recovered.turnStartMessages : [])
          .map((start) => [start.turnId, cloneTaskPlanState(start.taskState)]),
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
    taskState: TaskPlanState
  }[] {
    return [...this.turnStartMessages]
      .filter(([turnId, start]) =>
        (allowedTurnIds === undefined || allowedTurnIds.has(turnId))
        && start.length < messages.length
        && isMessagePrefix(start, messages))
      .map(([turnId, start]) => ({
        turnId,
        messages: structuredClone(start),
        taskState: cloneTaskPlanState(this.turnStartTaskStates.get(turnId)!),
      }))
  }

  private retainTurnStarts(turnIds: ReadonlySet<string>): void {
    this.turnStartMessages = new Map(
      [...this.turnStartMessages].filter(([turnId]) => turnIds.has(turnId)),
    )
    this.turnStartTaskStates = new Map(
      [...this.turnStartTaskStates].filter(([turnId]) => turnIds.has(turnId)),
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

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
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
