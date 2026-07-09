import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ModelMessage } from 'ai'
import {
  consensusPersistedStateSchema,
  type ConsensusPersistedState,
  type ConsensusTaskOutcome,
} from '../consensus/types.ts'
import type { StopReason } from '../events.ts'
import { buildLoadedSession, parseTranscript } from './chain.ts'
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
    return new SessionJournal(paths, metadata, start.uuid, [], null, null, null, null)
  }

  async open(sessionId: string): Promise<SessionJournal> {
    validateSessionId(sessionId)
    const paths = this.pathsFor(sessionId)
    const text = await readFile(paths.transcript, 'utf8')
    const loaded = buildLoadedSession(parseTranscript(text))
    if (loaded.metadata.sessionId !== sessionId) throw new Error('会话 ID 与目录不匹配')
    const metadata = loaded.metadata
    await writeMetadata(paths.metadata, metadata)
    return new SessionJournal(
      paths,
      metadata,
      loaded.leafUuid,
      loaded.messages,
      loaded.interruptedTurnId,
      loaded.interruptedConsensusTaskId,
      loaded.interruptedConsensusBaseMessages,
      loaded.consensusState,
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
  private activeTurnId: string | null
  private activeConsensusTaskId: string | null
  private activeConsensusBaseMessages: ModelMessage[] | null
  private consensusState: ConsensusPersistedState | null
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    paths: SessionPaths,
    metadata: SessionMetadata,
    leafUuid: string,
    messages: ModelMessage[],
    interruptedTurnId: string | null,
    interruptedConsensusTaskId: string | null,
    interruptedConsensusBaseMessages: ModelMessage[] | null,
    consensusState: ConsensusPersistedState | null,
  ) {
    this.paths = paths
    this.metadata = metadata
    this.sessionId = metadata.sessionId
    this.leafUuid = leafUuid
    this.messages = [...messages]
    this.activeTurnId = interruptedTurnId
    this.activeConsensusTaskId = interruptedConsensusTaskId
    this.activeConsensusBaseMessages = interruptedConsensusBaseMessages
    this.consensusState = consensusState
  }

  get initialMessages(): readonly ModelMessage[] {
    return this.messages
  }

  get interruptedTurnId(): string | null {
    return this.activeTurnId
  }

  get interruptedConsensusTaskId(): string | null {
    return this.activeConsensusTaskId
  }

  get initialConsensusState(): ConsensusPersistedState | null {
    return this.consensusState ? consensusPersistedStateSchema.parse(this.consensusState) : null
  }

  get metadataSnapshot(): SessionMetadata {
    return { ...this.metadata }
  }

  recordUserInput(text: string): Promise<void> {
    return this.enqueue(async () => {
      const input = this.entry({ type: 'user-input', text })
      await this.appendEntries([input])
      const clipped = clip(text)
      this.metadata.lastUserText = clipped
      if (!this.metadata.title) this.metadata.title = clipped
      this.metadata.updatedAt = input.timestamp
      await writeMetadata(this.paths.metadata, this.metadata)
    })
  }

  recordTurnStart(turnId: string, messages: ModelMessage[]): Promise<void> {
    return this.enqueue(async () => {
      const started = this.entry({ type: 'turn-start', turnId })
      const batch = this.entry({ type: 'messages', turnId, messages }, started.uuid)
      await this.appendEntries([started, batch])
      this.messages.push(...messages)
      this.activeTurnId = turnId
      this.metadata.updatedAt = started.timestamp
      this.metadata.status = 'running'
      await writeMetadata(this.paths.metadata, this.metadata)
    })
  }

  recordStep(turnId: string, messages: ModelMessage[]): Promise<void> {
    return this.enqueue(async () => {
      const batch = this.entry({ type: 'messages', turnId, messages })
      await this.appendEntries([batch])
      this.messages.push(...messages)
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
        stopReason === 'error' ? 'error' : this.activeConsensusTaskId ? 'running' : 'idle'
      await writeMetadata(this.paths.metadata, this.metadata)
    })
  }

  recordSnapshot(
    reason: 'compact' | 'rollback',
    messages: ModelMessage[],
    activeTurnId?: string,
  ): Promise<void> {
    return this.enqueue(async () => {
      const snapshot = this.entry(
        {
          type: 'snapshot',
          reason,
          activeTurnId: activeTurnId ?? null,
          activeConsensusTaskId: this.activeConsensusTaskId,
          activeConsensusBaseMessages: this.activeConsensusBaseMessages,
          consensusState: this.consensusState,
          modelId: this.metadata.modelId,
          messages,
        },
        null,
      )
      await this.appendEntries([snapshot])
      this.messages = [...messages]
      this.activeTurnId = activeTurnId ?? null
      this.metadata.updatedAt = snapshot.timestamp
      await writeMetadata(this.paths.metadata, this.metadata)
    })
  }

  recordConsensusTaskStart(taskId: string, state: ConsensusPersistedState): Promise<void> {
    return this.enqueue(async () => {
      if (this.activeConsensusTaskId) {
        throw new Error(`共识任务 ${this.activeConsensusTaskId} 尚未结束`)
      }
      const started = this.entry({ type: 'consensus-task-start', taskId, state })
      if (started.type !== 'consensus-task-start') throw new Error('无法写入共识任务起点')
      await this.appendEntries([started])
      this.activeConsensusTaskId = taskId
      this.activeConsensusBaseMessages = [...this.messages]
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
      if (this.activeConsensusTaskId !== taskId || !this.activeConsensusBaseMessages) {
        throw new Error(`共识任务 ${taskId} 没有匹配的活动起点`)
      }
      const rollbackMessages =
        outcome === 'completed' ? null : this.activeConsensusBaseMessages
      const ended = this.entry({
        type: 'consensus-task-end',
        taskId,
        outcome,
        state,
        rollbackMessages,
      })
      if (ended.type !== 'consensus-task-end') throw new Error('无法写入共识任务终点')
      await this.appendEntries([ended])
      if (ended.rollbackMessages) this.messages = [...ended.rollbackMessages]
      if (this.activeConsensusTaskId === taskId) this.activeConsensusTaskId = null
      this.activeConsensusBaseMessages = null
      this.consensusState = ended.state
      this.metadata.updatedAt = ended.timestamp
      this.metadata.status =
        outcome === 'error' ? 'error' : this.activeTurnId ? 'running' : 'idle'
      await writeMetadata(this.paths.metadata, this.metadata)
    })
  }

  /** 用户显式恢复时切断崩溃留下的活动边界；旧记录保留在 JSONL 中但不再进入活动父链。 */
  recoverInterruptedWork(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.activeTurnId && !this.activeConsensusTaskId) return
      const recovered = this.entry(
        {
          type: 'snapshot',
          reason: 'recovery',
          activeTurnId: null,
          activeConsensusTaskId: null,
          activeConsensusBaseMessages: null,
          consensusState: this.consensusState,
          modelId: this.metadata.modelId,
          messages: this.messages,
        },
        null,
      )
      await this.appendEntries([recovered])
      this.activeTurnId = null
      this.activeConsensusTaskId = null
      this.activeConsensusBaseMessages = null
      this.metadata.updatedAt = recovered.timestamp
      this.metadata.status = 'idle'
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

function clip(text: string): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
