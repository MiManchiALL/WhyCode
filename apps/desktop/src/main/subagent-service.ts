import { randomUUID } from 'node:crypto'
import {
  MAX_CONCURRENT_SUBAGENTS_PER_PARENT,
  MAX_SUBAGENT_PROMPT_PREVIEW_CHARS,
  SUBAGENT_SCHEMA_VERSION,
  createSubagentTools,
  type AuxiliaryImageAnalyzer,
  type AgentSession,
  type CoreEvent,
  type SessionJournal,
  type SkillCatalogService,
  type SubagentDefinitionCatalogService,
  type SubagentContinueRequest,
  type SubagentEventEnvelope,
  type SubagentLaunchRequest,
  type SubagentLaunchResult,
  type SubagentListEntry,
  type SubagentManifest,
  type SubagentModelSnapshot,
  type SubagentOutcome,
  type SubagentSettlementNotification,
  type SubagentState,
  type SubagentTranscriptSnapshot,
  type SubagentTurnState,
  type ToolDefinition,
  type TurnInterruptedSubagent,
} from '@whycode/core'
import type { PermissionMode } from '@whycode/core/permissions'
import type { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import type { HostOperationScheduler } from './host-operation-scheduler.ts'
import type { SessionScratchManager } from './session-scratch.ts'
import { SubagentStorage } from './subagent-storage.ts'
import {
  completedSubagentActivationDurationMs,
  completeSubagentManifest,
  createSubagentActivation,
  markSubagentSettlementDelivered,
  subagentContinuationKey,
  subagentFallbackResult,
  subagentListEntry,
  subagentOutcome,
  subagentSettlement,
  subagentSummary,
} from './subagent-record.ts'
import {
  createSubagentAgentSession,
  type ResolvedSubagentModel,
} from './subagent-session-factory.ts'
import { ViewTimeline } from './view-timeline.ts'

interface ActiveActivation {
  parentRuntime: DesktopSessionRuntime
  parentSessionId: string
  subagentId: string
  activationId: string
  taskDescription: string
  journal: SessionJournal
  timeline: ViewTimeline
  session: AgentSession | null
  cancelRequested: boolean
  suppressSettlement: boolean
  terminalReached: boolean
  done: Promise<void>
}

export interface ParentSubagentAbort {
  interruptedSubagents: TurnInterruptedSubagent[]
  done: Promise<void>
}

interface ActivationPreparation {
  parentSessionId: string
  subagentId?: string
  cancelled: boolean
  done: Promise<void>
  finish: () => void
}

export interface SubagentServiceOptions {
  sessionsRoot: string
  scratch: SessionScratchManager
  definitions: SubagentDefinitionCatalogService
  skills: SkillCatalogService
  webSearchTool: ToolDefinition
  createWebPageTools: (journal: SessionJournal) => ToolDefinition[]
  selectModel: (parent: SubagentModelSnapshot) => SubagentModelSnapshot | null
  resolveModel: (modelId: string) => ResolvedSubagentModel | null
  auxiliaryImageAnalyzer: () => AuxiliaryImageAnalyzer | undefined
  hostOperations: HostOperationScheduler
  onState: (state: SubagentState) => void
  onEvent: (envelope: SubagentEventEnvelope) => void
  onSettlement: (notification: SubagentSettlementNotification) => void
  onParentIdle: (runtime: DesktopSessionRuntime) => void
  onError?: (error: unknown) => void
}

/**
 * Durable ChildSession + ephemeral Activation：磁盘保存独立历史和终态，内存只保存
 * 当前最多 8 个激活。父会话切换不取消；停止、删除和退出通过显式生命周期入口取消。
 */
export class SubagentService {
  readonly definitions: SubagentDefinitionCatalogService
  private readonly options: SubagentServiceOptions
  private readonly storage: SubagentStorage
  private readonly active = new Map<string, ActiveActivation>()
  private readonly preparations = new Set<ActivationPreparation>()
  private readonly activeCounts = new Map<string, number>()
  private readonly continuationCounts = new Map<string, number>()
  private readonly coldTranscriptLoads = new Map<string, Promise<SubagentTranscriptSnapshot>>()
  private stateRevision = 0
  private eventSequence = 0
  private closing = false

  constructor(options: SubagentServiceOptions) {
    this.options = options
    this.storage = new SubagentStorage(options.sessionsRoot)
    this.definitions = options.definitions
  }

  async initialize(): Promise<void> {
    for (const manifest of await this.storage.listAllManifests()) {
      let current = manifest
      const last = current.activations.at(-1)!
      if (!last.outcome) {
        current = completeSubagentManifest(
          current,
          last.id,
          'error',
          'WhyCode 上次退出时该子代理仍在运行，原激活无法安全重连。',
        )
        await this.storage.writeManifest(current)
      }
      for (const activation of current.activations) {
        if (activation.settlement !== 'pending' || !activation.outcome) continue
        this.addContinuation(current.parentSessionId, activation.engagedPlanId)
        this.options.onSettlement(subagentSettlement(current, activation))
      }
    }
  }

  createTools(
    parentRuntime: DesktopSessionRuntime,
    parentJournal: SessionJournal,
    projectDir: string,
  ): ToolDefinition[] {
    return createSubagentTools(this.definitions, projectDir, {
      launch: (request) => this.launch(parentRuntime, parentJournal, projectDir, request),
      continue: (request) => this.continue(parentRuntime, parentJournal, projectDir, request),
      list: () => this.list(parentJournal.sessionId),
    })
  }

  hasPendingPlanContinuation(parentSessionId: string, planId: string): boolean {
    return (this.continuationCounts.get(subagentContinuationKey(parentSessionId, planId)) ?? 0) > 0
  }

  /** 应用级权限收窄必须同步到正在运行的子代理，不能等下一次冷激活才生效。 */
  setPermissionModeForAll(mode: PermissionMode): void {
    for (const activation of this.active.values()) activation.session?.setPermissionMode(mode)
  }

  async state(parentSessionId: string): Promise<SubagentState> {
    const manifests = await this.storage.listManifests(parentSessionId)
    return {
      parentSessionId,
      revision: ++this.stateRevision,
      subagents: manifests.map(subagentSummary),
    }
  }

  async list(parentSessionId: string): Promise<SubagentListEntry[]> {
    return (await this.storage.listManifests(parentSessionId)).map(subagentListEntry)
  }

  /** 当前父 turn 的轻量事实投影；manifest 仍是唯一持久事实源。 */
  async turnState(parentSessionId: string, parentTurnId: string): Promise<SubagentTurnState> {
    const activations = (await this.storage.listManifests(parentSessionId))
      .flatMap((manifest) => manifest.activations
        .filter((activation) => activation.parentTurnId === parentTurnId)
        .map((activation) => ({
          startedAt: activation.startedAt,
          value: {
            subagentId: manifest.id,
            activationId: activation.id,
            name: manifest.definition.name,
            description: manifest.taskDescription,
            sequence: activation.sequence,
            ...(activation.outcome ? { outcome: activation.outcome } : {}),
            ...(activation.settlement ? { settlement: activation.settlement } : {}),
          },
        })))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map((item) => item.value)
    return { parentTurnId, activations }
  }

  async transcript(
    parentSessionId: string,
    subagentId: string,
  ): Promise<SubagentTranscriptSnapshot> {
    const live = this.ownedActivation(parentSessionId, subagentId)
    if (live) return this.loadTranscript(parentSessionId, subagentId, live)

    const key = `${parentSessionId}:${subagentId}`
    const existing = this.coldTranscriptLoads.get(key)
    if (existing) return existing
    let pending!: Promise<SubagentTranscriptSnapshot>
    pending = this.loadTranscript(parentSessionId, subagentId, null)
      .finally(() => {
        if (this.coldTranscriptLoads.get(key) === pending) {
          this.coldTranscriptLoads.delete(key)
        }
      })
    this.coldTranscriptLoads.set(key, pending)
    return pending
  }

  private async loadTranscript(
    parentSessionId: string,
    subagentId: string,
    knownLive: ActiveActivation | null,
  ): Promise<SubagentTranscriptSnapshot> {
    const manifest = await this.storage.readManifest(parentSessionId, subagentId)
    const beforeOpen = knownLive ?? this.ownedActivation(parentSessionId, subagentId)
    const opened = beforeOpen?.journal ?? await this.storage.open(parentSessionId, subagentId)
    const live = beforeOpen ?? this.ownedActivation(parentSessionId, subagentId)
    const journal = live?.journal ?? opened
    const timeline = live
      ? await live.timeline.snapshotAt(journal, () => this.eventSequence)
      : {
          events: journal.initialViewEvents.map((event) => structuredClone(event)),
          eventTimestamps: [...journal.initialViewEventTimestamps],
          boundary: this.eventSequence,
        }
    return {
      subagent: subagentSummary(manifest),
      viewEvents: timeline.events,
      viewEventTimestamps: timeline.eventTimestamps,
      eventSequence: timeline.boundary,
    }
  }

  async markSettlementDelivered(notification: SubagentSettlementNotification): Promise<void> {
    let manifest: SubagentManifest
    try {
      manifest = await this.storage.readManifest(
        notification.parentSessionId,
        notification.subagentId,
      )
    } catch {
      return
    }
    const activation = manifest.activations.find((item) => item.id === notification.activationId)
    if (!activation || activation.settlement === 'delivered') return
    await this.storage.writeManifest(markSubagentSettlementDelivered(
      manifest,
      notification.activationId,
    ))
    this.removeContinuation(manifest.parentSessionId, activation.engagedPlanId)
  }

  beginParentAbort(parentSessionId: string): ParentSubagentAbort {
    const preparations = [...this.preparations].filter(
      (preparation) => preparation.parentSessionId === parentSessionId,
    )
    for (const preparation of preparations) preparation.cancelled = true
    const targets = [...this.active.values()].filter(
      (activation) => activation.parentSessionId === parentSessionId,
    )
    const interrupted = targets.filter(
      (activation) => !activation.terminalReached && !activation.cancelRequested,
    )
    if (targets.length > 0) targets[0]!.parentRuntime.rejectApprovals()
    for (const activation of targets) activation.suppressSettlement = true
    for (const activation of interrupted) {
      activation.cancelRequested = true
      activation.session?.abort()
    }
    return {
      interruptedSubagents: interrupted.map((activation) => ({
        subagentId: activation.subagentId,
        description: activation.taskDescription,
      })),
      done: Promise.all([
        ...preparations.map((preparation) => preparation.done),
        ...targets.map((activation) => activation.done),
      ]).then(() => undefined),
    }
  }

  async forgetParent(parentSessionId: string): Promise<void> {
    await this.beginParentAbort(parentSessionId).done
    for (const key of [...this.continuationCounts.keys()]) {
      if (key.startsWith(`${parentSessionId}:`)) this.continuationCounts.delete(key)
    }
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    const preparations = [...this.preparations]
    for (const preparation of preparations) preparation.cancelled = true
    const targets = [...this.active.values()]
    for (const runtime of new Set(targets.map((activation) => activation.parentRuntime))) {
      runtime.rejectApprovals()
    }
    for (const activation of targets) {
      activation.cancelRequested = true
      activation.session?.abort()
    }
    await Promise.all([
      ...preparations.map((preparation) => preparation.done),
      ...targets.map((activation) => activation.done),
    ])
  }

  private async launch(
    parentRuntime: DesktopSessionRuntime,
    parentJournal: SessionJournal,
    projectDir: string,
    request: SubagentLaunchRequest,
  ): Promise<SubagentLaunchResult> {
    if (!this.reserve(parentJournal.sessionId)) {
      return {
        ok: false,
        error: `当前会话并行运行的子代理已达到上限（${MAX_CONCURRENT_SUBAGENTS_PER_PARENT} 个）`,
      }
    }
    const preparation = this.beginPreparation(parentJournal.sessionId)
    let journal: SessionJournal | null = null
    let continuationAdded = false
    try {
      this.assertPreparation(preparation, parentRuntime, parentJournal)
      const parentModelId = parentRuntime.modelId
      if (!parentModelId) throw new Error('父会话没有可继承的模型')
      const model = this.options.selectModel({
        modelId: parentModelId,
        reasoningEffort: parentRuntime.reasoningEffort,
      })
      if (!model) throw new Error('子代理模型连接不可用')
      journal = await this.storage.create(parentJournal.sessionId, {
        workspace: parentJournal.metadataSnapshot.workspace,
        modelId: model.modelId,
        reasoningEffort: model.reasoningEffort,
      })
      preparation.subagentId = journal.sessionId
      this.assertPreparation(preparation, parentRuntime, parentJournal)
      const now = new Date().toISOString()
      const activation = createSubagentActivation(
        request,
        1,
        now,
        MAX_SUBAGENT_PROMPT_PREVIEW_CHARS,
      )
      const permission = parentRuntime.session?.permissionSnapshot
      if (!permission) throw new Error('父会话权限上下文尚未建立')
      const manifest: SubagentManifest = {
        schemaVersion: SUBAGENT_SCHEMA_VERSION,
        id: journal.sessionId,
        parentSessionId: parentJournal.sessionId,
        createdByTurnId: request.parentTurnId,
        createdByToolCallId: request.parentToolCallId,
        taskDescription: request.taskDescription,
        definition: structuredClone(request.definition),
        modelId: model.modelId,
        reasoningEffort: model.reasoningEffort,
        permission,
        createdAt: now,
        updatedAt: now,
        activations: [activation],
      }
      await this.storage.writeManifest(manifest)
      this.assertPreparation(preparation, parentRuntime, parentJournal)
      await this.options.scratch.ensureSubagent(parentJournal.sessionId, journal.sessionId)
      this.assertPreparation(preparation, parentRuntime, parentJournal)
      this.addContinuation(parentJournal.sessionId, request.engagedPlanId)
      continuationAdded = true
      this.startActivation(parentRuntime, projectDir, manifest, journal, request.prompt)
      await this.publishState(parentJournal.sessionId)
      return {
        ok: true,
        subagentId: journal.sessionId,
        name: request.definition.name,
        description: request.taskDescription,
      }
    } catch (error) {
      if (continuationAdded) {
        this.removeContinuation(parentJournal.sessionId, request.engagedPlanId)
      }
      if (journal) {
        await this.storage.remove(parentJournal.sessionId, journal.sessionId).catch(() => {})
      }
      this.release(parentJournal.sessionId)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.finishPreparation(preparation)
    }
  }

  private async continue(
    parentRuntime: DesktopSessionRuntime,
    parentJournal: SessionJournal,
    projectDir: string,
    request: SubagentContinueRequest,
  ): Promise<SubagentLaunchResult> {
    if (this.subagentActivationReserved(request.subagentId)) {
      return { ok: false, error: '该子代理仍在运行，不能并发继续' }
    }
    if (!this.reserve(parentJournal.sessionId)) {
      return {
        ok: false,
        error: `当前会话并行运行的子代理已达到上限（${MAX_CONCURRENT_SUBAGENTS_PER_PARENT} 个）`,
      }
    }
    const preparation = this.beginPreparation(parentJournal.sessionId, request.subagentId)
    let previousManifest: SubagentManifest | null = null
    let continuationAdded = false
    try {
      this.assertPreparation(preparation, parentRuntime, parentJournal)
      let manifest = await this.storage.readManifest(parentJournal.sessionId, request.subagentId)
      previousManifest = manifest
      this.assertPreparation(preparation, parentRuntime, parentJournal)
      const last = manifest.activations.at(-1)!
      if (!last.outcome) throw new Error('该子代理仍在运行，不能并发继续')
      const journal = await this.storage.open(parentJournal.sessionId, request.subagentId)
      await journal.recoverInterruptedWork()
      this.assertPreparation(preparation, parentRuntime, parentJournal)
      const now = new Date().toISOString()
      const activation = createSubagentActivation(
        request,
        last.sequence + 1,
        now,
        MAX_SUBAGENT_PROMPT_PREVIEW_CHARS,
      )
      manifest = {
        ...manifest,
        updatedAt: now,
        activations: [...manifest.activations, activation],
      }
      await this.storage.writeManifest(manifest)
      this.assertPreparation(preparation, parentRuntime, parentJournal)
      await this.options.scratch.ensureSubagent(parentJournal.sessionId, request.subagentId)
      this.assertPreparation(preparation, parentRuntime, parentJournal)
      this.addContinuation(parentJournal.sessionId, request.engagedPlanId)
      continuationAdded = true
      this.startActivation(parentRuntime, projectDir, manifest, journal, request.prompt)
      await this.publishState(parentJournal.sessionId)
      return {
        ok: true,
        subagentId: request.subagentId,
        name: manifest.definition.name,
        description: manifest.taskDescription,
      }
    } catch (error) {
      if (continuationAdded) {
        this.removeContinuation(parentJournal.sessionId, request.engagedPlanId)
      }
      if (previousManifest) {
        await this.storage.writeManifest(previousManifest).catch((rollbackError) => {
          this.report(rollbackError)
        })
      }
      this.release(parentJournal.sessionId)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      this.finishPreparation(preparation)
    }
  }

  private startActivation(
    parentRuntime: DesktopSessionRuntime,
    projectDir: string,
    manifest: SubagentManifest,
    journal: SessionJournal,
    prompt: string,
  ): void {
    if (this.active.has(manifest.id)) throw new Error('该子代理激活已经存在')
    const activation = manifest.activations.at(-1)!
    const timeline = new ViewTimeline((error) => this.report(error))
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const active: ActiveActivation = {
      parentRuntime,
      parentSessionId: manifest.parentSessionId,
      subagentId: manifest.id,
      activationId: activation.id,
      taskDescription: manifest.taskDescription,
      journal,
      timeline,
      session: null,
      cancelRequested: false,
      suppressSettlement: false,
      terminalReached: false,
      done,
    }
    this.active.set(manifest.id, active)
    parentRuntime.beginExternalWork()
    void this.runActivation(active, projectDir, manifest, prompt)
      .catch((error) => this.report(error))
      .finally(() => resolveDone())
  }

  private async runActivation(
    active: ActiveActivation,
    projectDir: string,
    initialManifest: SubagentManifest,
    prompt: string,
  ): Promise<void> {
    let outcome: SubagentOutcome = 'error'
    let resultText = ''
    let session: AgentSession | null = null
    try {
      session = await createSubagentAgentSession({
        parentRuntime: active.parentRuntime,
        projectDir,
        manifest: initialManifest,
        journal: active.journal,
        scratch: this.options.scratch,
        skills: this.options.skills,
        webSearchTool: this.options.webSearchTool,
        createWebPageTools: this.options.createWebPageTools,
        resolveModel: this.options.resolveModel,
        auxiliaryImageAnalyzer: this.options.auxiliaryImageAnalyzer,
        hostOperations: this.options.hostOperations,
        emit: (event) => this.emitChildEvent(active, event),
      })
      active.session = session
      if (active.cancelRequested) throw new Error('父会话已停止，本次子代理激活已取消。')
      const inputId = randomUUID()
      await active.journal.recordUserInputWithId(inputId, prompt, true)
      if (active.cancelRequested) throw new Error('父会话已停止，本次子代理激活已取消。')
      this.broadcastChildEvent(active, {
        type: 'user-message-accepted',
        inputId,
        text: prompt,
        startsTurn: true,
      })
      const handling = session.handleUserMessage(prompt, false, [], inputId)
      const stopReason = handling ? await handling : 'error'
      resultText = session.latestTurnAssistantText
      outcome = subagentOutcome(stopReason, session.modelFinishReason)
    } catch (error) {
      outcome = active.cancelRequested ? 'aborted' : 'error'
      resultText = error instanceof Error ? error.message : String(error)
    } finally {
      active.session = null
      active.terminalReached = true
      if (!resultText.trim()) resultText = subagentFallbackResult(outcome)
      let manifest = await this.finishActivation(
        initialManifest.parentSessionId,
        initialManifest.id,
        active.activationId,
        outcome,
        resultText,
        session?.permissionSnapshot,
      ).catch((error) => {
        this.report(error)
        return null
      })
      const terminalActivation = manifest?.activations.find(
        (item) => item.id === active.activationId,
      )
      if (terminalActivation) {
        this.emitChildEvent(active, {
          type: 'work-finished',
          durationMs: completedSubagentActivationDurationMs(terminalActivation),
          outcome: outcome === 'completed' ? 'completed' : 'stopped',
          forkTurnId: null,
        }, terminalActivation.endedAt)
      }
      await active.timeline.flush().catch((error) => this.report(error))
      await session?.dispose().catch((error) => this.report(error))
      this.release(active.parentSessionId)
      active.parentRuntime.endExternalWork()
      try {
        this.options.onParentIdle(active.parentRuntime)
      } catch (error) {
        this.report(error)
      }
      await this.publishState(active.parentSessionId)
      if (manifest) {
        const activation = manifest.activations.find((item) => item.id === active.activationId)!
        if (active.suppressSettlement) {
          manifest = markSubagentSettlementDelivered(manifest, active.activationId)
          await this.storage.writeManifest(manifest).catch((error) => this.report(error))
          this.removeContinuation(manifest.parentSessionId, activation.engagedPlanId)
        } else {
          try {
            this.options.onSettlement(subagentSettlement(manifest, activation))
          } catch (error) {
            this.report(error)
          }
        }
      }
      this.active.delete(active.subagentId)
    }
  }

  private async finishActivation(
    parentSessionId: string,
    subagentId: string,
    activationId: string,
    outcome: SubagentOutcome,
    resultText: string,
    permission: AgentSession['permissionSnapshot'] | undefined,
  ): Promise<SubagentManifest> {
    const manifest = await this.storage.readManifest(parentSessionId, subagentId)
    const terminal = completeSubagentManifest(manifest, activationId, outcome, resultText)
    const next = permission ? { ...terminal, permission } : terminal
    await this.storage.writeManifest(next)
    return next
  }

  private emitChildEvent(
    active: ActiveActivation,
    event: CoreEvent,
    occurredAt = new Date().toISOString(),
  ): void {
    active.timeline.capture(active.journal, event, occurredAt)
    this.options.onEvent({
      parentSessionId: active.parentSessionId,
      subagentId: active.subagentId,
      sequence: ++this.eventSequence,
      occurredAt,
      event,
    })
  }

  private broadcastChildEvent(active: ActiveActivation, event: CoreEvent): void {
    this.options.onEvent({
      parentSessionId: active.parentSessionId,
      subagentId: active.subagentId,
      sequence: ++this.eventSequence,
      occurredAt: new Date().toISOString(),
      event,
    })
  }

  private async publishState(parentSessionId: string): Promise<void> {
    try {
      this.options.onState(await this.state(parentSessionId))
    } catch (error) {
      this.report(error)
    }
  }

  private ownedActivation(
    parentSessionId: string,
    subagentId: string,
  ): ActiveActivation | null {
    const active = this.active.get(subagentId)
    return active?.parentSessionId === parentSessionId ? active : null
  }

  private assertAvailable(
    runtime: DesktopSessionRuntime,
    journal: SessionJournal,
  ): void {
    if (this.closing) throw new Error('WhyCode 正在退出，不能启动子代理')
    if (runtime.isDisposed || runtime.journal !== journal || !runtime.session) {
      throw new Error('父会话运行时已变化，不能启动子代理')
    }
  }

  private assertPreparation(
    preparation: ActivationPreparation,
    runtime: DesktopSessionRuntime,
    journal: SessionJournal,
  ): void {
    if (preparation.cancelled) throw new Error('子代理启动已取消')
    this.assertAvailable(runtime, journal)
  }

  private beginPreparation(
    parentSessionId: string,
    subagentId?: string,
  ): ActivationPreparation {
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    const preparation: ActivationPreparation = {
      parentSessionId,
      ...(subagentId ? { subagentId } : {}),
      cancelled: false,
      done,
      finish,
    }
    this.preparations.add(preparation)
    return preparation
  }

  private finishPreparation(preparation: ActivationPreparation): void {
    if (!this.preparations.delete(preparation)) return
    preparation.finish()
  }

  private subagentActivationReserved(subagentId: string): boolean {
    return this.active.has(subagentId)
      || [...this.preparations].some((preparation) => preparation.subagentId === subagentId)
  }

  private reserve(parentSessionId: string): boolean {
    if (this.closing) return false
    const count = this.activeCounts.get(parentSessionId) ?? 0
    if (count >= MAX_CONCURRENT_SUBAGENTS_PER_PARENT) return false
    this.activeCounts.set(parentSessionId, count + 1)
    return true
  }

  private release(parentSessionId: string): void {
    const count = this.activeCounts.get(parentSessionId) ?? 0
    if (count <= 1) this.activeCounts.delete(parentSessionId)
    else this.activeCounts.set(parentSessionId, count - 1)
  }

  private addContinuation(parentSessionId: string, planId?: string): void {
    if (!planId) return
    const key = subagentContinuationKey(parentSessionId, planId)
    this.continuationCounts.set(key, (this.continuationCounts.get(key) ?? 0) + 1)
  }

  private removeContinuation(parentSessionId: string, planId?: string): void {
    if (!planId) return
    const key = subagentContinuationKey(parentSessionId, planId)
    const count = this.continuationCounts.get(key) ?? 0
    if (count <= 1) this.continuationCounts.delete(key)
    else this.continuationCounts.set(key, count - 1)
  }

  private report(error: unknown): void {
    try {
      this.options.onError?.(error)
    } catch {}
  }
}
