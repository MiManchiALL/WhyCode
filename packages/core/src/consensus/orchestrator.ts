import type { AgentSession, ApprovalHandler } from '../agent/session.ts'
import type { CoreEvent, CoreEventSink, QueuedUserMessage, StopReason } from '../events.ts'
import type { ImageAttachment, ImageDeliveryMode } from '../attachments/types.ts'
import type { PdfAttachment } from '../pdf/types.ts'
import type { ModelEntry, ProviderConfig } from '../providers/registry.ts'
import {
  createTurnAbortedMessage,
  type TurnInterruptionContext,
} from '../session/interruption.ts'
import { skillSummary, type ActivatedSkill } from '../skills/types.ts'
import { PeerAgent } from './peer-agent.ts'
import { runProtocolRound } from './run-round.ts'
import { runFullConsensus } from './full-consensus.ts'
import { extractMemorySummary, formatMemories } from './memory.ts'
import {
  buildConversationDigest,
  buildM1Prompt,
  buildMainOnlyExecutionPrompt,
  buildQuickReviewPrompt,
} from './prompts.ts'
import { createConsensusTaskScratch } from './scratch.ts'
import {
  consensusPersistedStateSchema,
  keepsConsensusProgress,
  type AgentMemorySummary,
  type CandidateContent,
  type ConsensusAgentId,
  type ConsensusPersistedState,
  type ConsensusTaskOutcome,
  type ProtocolOutput,
} from './types.ts'

export interface ConsensusAgentSetup {
  model: ModelEntry
  providerConfig: ProviderConfig
}

/** 用户显式要求多 Agent 协商的表述（协议 §1.1 的升级触发词；控制面确定性规则，不依赖模型自觉） */
const EXPLICIT_CONSENSUS_RE =
  /充分讨论|多视角|多角度|互相评价|互相讨论|达成共识|完整共识|共识决策|你们.{0,4}讨论|大家.{0,6}讨论|一起讨论|(?:三|3)\s*(?:个\s*)?(?:agent|模型)|三方(?:协商|讨论|评审)|多个\s*agent|full[_\s-]?consensus/i

/** 硬性风险触发词（协议 §1.1：高风险任务必须 full_consensus；保守收窄，避免误伤日常任务） */
const HARD_RISK_RE = /(数据库|数据)\s*迁移|删库|生产环境|支付|payment/i

/** 用户明确指定多方协商或任务命中硬风险时，由控制面锁定 full_consensus。 */
export function requiresFullConsensus(userText: string): boolean {
  return EXPLICIT_CONSENSUS_RE.test(userText) || HARD_RISK_RE.test(userText)
}

export interface ConsensusCoordinatorOptions {
  /** Main = 用户对话的既有会话（最终执行者，保留完整上下文） */
  mainSession: AgentSession
  projectDir: string
  /** 当前会话的 scratch 根；协商任务只在其 consensus 子树中创建目录。 */
  sessionScratchDir: string
  agents: { B: ConsensusAgentSetup; C: ConsensusAgentSetup }
  osPlatform: NodeJS.Platform
  homeDir?: string
  emit: CoreEventSink
  requestApproval: ApprovalHandler
  /** M4：只恢复上一任务已提交的稳定状态，不恢复 Peer 会话或半截协议。 */
  initialState?: ConsensusPersistedState | null
  onTaskStart?: (
    taskId: string,
    state: ConsensusPersistedState,
    userText: string,
    deliveredInputIds?: readonly string[],
    skills?: readonly ActivatedSkill[],
  ) => Promise<void>
  onTaskEnd?: (
    taskId: string,
    outcome: ConsensusTaskOutcome,
    state: ConsensusPersistedState,
  ) => Promise<void>
  /** Coordinator 自持队列在停止时先持久化为 Renderer 草稿，再发送恢复事件。 */
  onInputsRestored?: (inputIds: readonly string[]) => Promise<void>
}

interface CoordinatorMessage {
  id: string
  persistedInputId?: string
  text: string
  attachments: ImageAttachment[]
  imageDelivery?: ImageDeliveryMode
  pdfAttachments: PdfAttachment[]
  /** 输入被接受时冻结的完整快照；讨论/协议阶段只保管，不向模型暴露。 */
  skills: ActivatedSkill[]
}

/**
 * 协商协调器（M3-b/c：三种协议模式）。Orchestrator 是控制面代码非 LLM（协议 §4.3）：
 * 只管流程/模式锁定/输入包组装/计分/事件广播，不判断方案质量。
 * Main 讨论档输出 M1（锁定 protocol_mode）→ main_only 直接放行 / quick_review 一轮快评 /
 * full_consensus 三轮完整协商（full-consensus.ts）→ 执行包注入 Main → Main 执行。
 */
export class ConsensusCoordinator {
  private options: ConsensusCoordinatorOptions
  private taskCounter = 0
  private peers: PeerAgent[] = []
  private running = false
  /** B/C 工作期间（Main 空闲）用户插话暂存，注入执行阶段输入包 */
  private pendingTexts: CoordinatorMessage[] = []
  /** Main 已结束、协调器仍在提交任务终点时到达的消息；任务提交后按新协商任务交接。 */
  private deferredTaskMessages: CoordinatorMessage[] = []
  private peerPhase = false
  /** 区分 Main 的 M1 讨论与最终执行，保证 Skill 只进入普通执行工具面。 */
  private executionPhase = false
  private aborted = false
  /** 对话级累计分数（协议 §5.3：跨任务保留，新对话随协调器重建而重置） */
  private sessionScore: Record<ConsensusAgentId, number> = { Main: 0, B: 0, C: 0 }
  /** B/C 跨任务记忆（协议 §10：任务结束只留结构化摘要，下任务注入） */
  private memories: Record<'B' | 'C', AgentMemorySummary[]> = { B: [], C: [] }
  /** 对话内任务脉络（含 main_only；B/C 首轮注入摘要，补齐"刚才那个"类指代） */
  private taskLog: { taskId: string; userText: string; m1Summary: string }[] = []

  constructor(options: ConsensusCoordinatorOptions) {
    this.options = options
    if (options.initialState) this.restoreState(options.initialState)
  }

  get busy(): boolean {
    return this.running
  }

  /** 最新根消息换根后，让同一个空闲协调器回到该消息之前的累计协商状态。 */
  resetPersistedState(state: ConsensusPersistedState | null): void {
    if (this.running || this.options.mainSession.isBusy) {
      throw new Error('协商仍在运行，不能恢复历史状态')
    }
    this.taskCounter = 0
    this.sessionScore = { Main: 0, B: 0, C: 0 }
    this.memories = { B: [], C: [] }
    this.taskLog = []
    this.pendingTexts = []
    this.deferredTaskMessages = []
    this.peers = []
    this.peerPhase = false
    this.executionPhase = false
    this.aborted = false
    if (state) this.restoreState(state)
  }

  /** 用户消息入口：空闲开新协商任务；Main 探索中走会话自身 steering；B/C 工作中暂存 */
  handleUserMessage(
    text: string,
    urgent = false,
    attachments: readonly ImageAttachment[] = [],
    persistedInputId?: string,
    pdfAttachments: readonly PdfAttachment[] = [],
    skills: readonly ActivatedSkill[] = [],
    imageDelivery?: ImageDeliveryMode,
  ): Promise<StopReason | void> | void {
    const message = this.coordinatorMessage(
      text, attachments, persistedInputId, pdfAttachments, skills, imageDelivery,
    )
    if (attachments.length > 0 || pdfAttachments.length > 0) {
      if (!this.running && !this.options.mainSession.isBusy) {
        this.options.emit({
          type: 'consensus-skipped',
          reason: pdfAttachments.length > 0 ? 'pdf-input' : 'image-input',
        })
        return this.options.mainSession.handleUserMessage(
          text,
          urgent,
          attachments,
          persistedInputId,
          pdfAttachments,
          skills,
          imageDelivery,
        )
      }
      // 协调器空闲但 Main 仍在处理上一条附件任务时，附件仍是同一任务的 steering。
      if (!this.running) {
        return this.options.mainSession.handleUserMessage(
          text,
          urgent,
          attachments,
          persistedInputId,
          pdfAttachments,
          skills,
          imageDelivery,
        )
      }
      if (this.peerPhase) {
        if (urgent) {
          this.deferredTaskMessages.push(message)
          this.emitQueued(message)
          this.interruptForDeferredInput()
        } else {
          // B/C 永远不接收附件；补充消息只在后续 Main 执行边界原样注入。
          this.pendingTexts.push(message)
          this.emitQueued(message)
        }
        return
      }
      if (this.options.mainSession.isRunning) {
        if (!this.executionPhase && message.skills.length > 0) {
          return this.queueUntilExecution(message, urgent)
        }
        return this.options.mainSession.handleUserMessage(
          text,
          urgent,
          attachments,
          persistedInputId,
          pdfAttachments,
          skills,
          imageDelivery,
        )
      }
      this.deferredTaskMessages.push(message)
      this.emitQueued(message)
      if (urgent) this.interruptForDeferredInput()
      return
    }
    if (!this.running) {
      if (this.options.mainSession.isBusy) return this.deferUntilMainIdle(message)
      return this.runTask(text, [], skills)
    }
    if (this.peerPhase) {
      this.pendingTexts.push(message)
      this.emitQueued(message)
      return
    }
    if (!this.options.mainSession.isRunning) {
      this.deferredTaskMessages.push(message)
      this.emitQueued(message)
      return
    }
    if (!this.executionPhase && message.skills.length > 0) {
      return this.queueUntilExecution(message, urgent)
    }
    this.options.mainSession.handleUserMessage(text, urgent, [], persistedInputId, [], skills)
  }

  private queueUntilExecution(message: CoordinatorMessage, urgent: boolean): void {
    if (urgent) {
      this.deferredTaskMessages.push(message)
      this.emitQueued(message)
      this.interruptForDeferredInput()
      return
    }
    this.pendingTexts.push(message)
    this.emitQueued(message)
  }

  private async deferUntilMainIdle(message: CoordinatorMessage): Promise<void> {
    this.deferredTaskMessages.push(message)
    this.running = true
    this.aborted = false
    this.emitQueued(message)
    await this.options.mainSession.waitUntilIdle()
    if (this.aborted) {
      this.running = false
      this.options.emit({ type: 'agent-status', status: 'idle' })
      return
    }
    const next = this.deferredTaskMessages.shift()
    this.running = false
    if (!next) return
    await this.deliverDeferredMessage(next)
  }

  /** 取消整个协商（含 B/C）；暂存的插话文本还给输入框 */
  async abort(context?: TurnInterruptionContext): Promise<void> {
    this.aborted = true
    for (const peer of this.peers) peer.abort()
    this.options.mainSession.abort(context)
    const queued = [...this.pendingTexts, ...this.deferredTaskMessages]
    this.pendingTexts = []
    this.deferredTaskMessages = []
    await this.restoreQueuedMessages(queued)
  }

  private async runTask(
    userText: string,
    deliveredInputIds: readonly string[] = [],
    skills: readonly ActivatedSkill[] = [],
  ): Promise<void> {
    const { mainSession, emit } = this.options
    this.running = true
    this.aborted = false
    emit({ type: 'agent-status', status: 'working' })
    mainSession.setTerminalStatusManaged(true)
    mainSession.setUserQuestionsEnabled(false)
    const taskId = `task-${++this.taskCounter}`
    const startState = this.snapshotState()
    const startMessages = mainSession.captureMessageSnapshot()
    const interruptedBaseMessages = [
      ...startMessages,
      { role: 'user' as const, content: userText },
    ]
    const startTaskState = mainSession.captureTaskStateSnapshot()
    let outcome: ConsensusTaskOutcome = 'error'
    let taskBoundaryStarted = false
    let taskPlanRolledBack = false
    try {
      taskBoundaryStarted = await this.persistTaskStart(
        taskId,
        startState,
        userText,
        deliveredInputIds,
        skills,
      )
      if (!taskBoundaryStarted) return
      for (const inputId of deliveredInputIds) {
        emit({
          type: 'message-injected',
          id: inputId,
          text: userText,
          startsTurn: true,
          ...(skills.length ? { skills: skills.map(skillSummary) } : {}),
        })
      }
      if (this.aborted) {
        outcome = 'aborted'
        return
      }
      const scratch = await createConsensusTaskScratch(
        this.options.sessionScratchDir,
        taskId,
      )
      if (this.aborted) {
        outcome = 'aborted'
        return
      }

      // 第一步：Main 讨论档输出 M1 + protocol_mode（协议 §1.1：模式只出现在首个 M1）
      const forceFullConsensus = requiresFullConsensus(userText)
      mainSession.setDiscussion({ agentId: 'Main', scratchDir: scratch.agentDirs.Main })
      const m1Result = await runProtocolRound(
        mainSession,
        buildM1Prompt(userText, forceFullConsensus),
        {
          agentId: 'Main',
          round: 1,
          kind: 'full',
          mustVote: [],
          existingCandidateIds: [],
          requireProtocolMode: true,
          forcedProtocolMode: forceFullConsensus ? 'full_consensus' : undefined,
        },
      )
      if (this.aborted) {
        outcome = 'aborted'
        return
      }
      if (!m1Result.ok) {
        emit({ type: 'error', message: `协商失败（Main 未产出 M1）：${m1Result.error}`, recoverable: true })
        return
      }
      const m1 = m1Result.output
      // 协议 §1.1：用户显式要求多视角/共识、或命中硬性风险词时，Orchestrator 强制升级 full_consensus（只升不降）
      const mode = forceFullConsensus ? 'full_consensus' : (m1.protocolMode ?? 'main_only')
      emit({
        type: 'candidate-submitted',
        agentId: 'Main',
        candidateId: 'M1',
        summary: m1.candidate?.summary ?? '',
        // main_only 随后会交付完整答案；仅在真正进入 B/C 评审时展开 M1，避免重复展示。
        details: mode !== 'main_only' && m1.candidate
          ? {
              finalAnswerOrPlan: m1.candidate.finalAnswerOrPlan,
              evidenceRefs: m1.candidate.evidenceRefs,
              knownRisks: m1.candidate.knownRisks,
            }
          : undefined,
      })
      // 任务脉络：摘要给本任务的 B/C（不含本任务），随后登记本任务（main_only 也登记）
      const digest = buildConversationDigest(this.taskLog)
      this.taskLog.push({ taskId, userText, m1Summary: m1.candidate?.summary ?? '' })

      // main_only：无需评审，恢复执行档直接放行（协议 §6.1，行为与单 Agent 一致）
      if (mode === 'main_only') {
        this.restoreExecution()
        emit({ type: 'execution-started', taskId })
        this.executionPhase = true
        const execution = this.takePendingInputs(
          buildMainOnlyExecutionPrompt(userText, m1.candidate),
          skills,
        )
        const stopReason = await mainSession.handleExecutionMessage(
          execution.text,
          execution.inputs,
          execution.skills,
        )
        outcome = this.executionOutcome(stopReason)
        return
      }

      // 需评审的模式：B/C 开始工作，全局状态由协调器接管
      emit({ type: 'negotiation-started', taskId, mode })
      emit({ type: 'agent-status', status: 'working' })
      this.peerPhase = true

      let packageText: string | null
      if (mode === 'full_consensus') {
        const result = await runFullConsensus({
          emit,
          mainSession,
          makePeer: (agentId) => this.makePeer(agentId, scratch.agentDirs[agentId]),
          taskId,
          userText,
          m1,
          memoryOf: (agentId) => digest + formatMemories(this.memories[agentId]),
          sessionScore: this.sessionScore,
          isAborted: () => this.aborted,
        })
        packageText = result?.packageText ?? null
        if (result) this.saveMemories(taskId, [...result.outputs.values()])
      } else {
        packageText = await this.runQuickReview(userText, m1.candidate, taskId, scratch.agentDirs, digest)
      }
      this.peerPhase = false
      if (this.aborted || packageText === null) {
        outcome = this.aborted ? 'aborted' : 'error'
        return
      }

      // 执行阶段：被选中候选与支持票一次性注入 Main（协议 §15.2），恢复执行档
      this.restoreExecution()
      emit({ type: 'execution-started', taskId })
      this.executionPhase = true
      const execution = this.takePendingInputs(packageText, skills)
      const stopReason = await mainSession.handleExecutionMessage(
        execution.text,
        execution.inputs,
        execution.skills,
      )
      outcome = this.executionOutcome(stopReason)
    } catch (error) {
      emit({
        type: 'error',
        message: `协商流程异常：${error instanceof Error ? error.message : String(error)}`,
        recoverable: true,
      })
    } finally {
      if (!keepsConsensusProgress(outcome)) {
        this.restoreState(startState)
        const rollbackMessages = [
          ...interruptedBaseMessages,
          createTurnAbortedMessage(
            outcome === 'aborted' ? 'user-cancel' : 'consensus-failure',
          ),
        ]
        mainSession.restoreMessageSnapshot(rollbackMessages)
        if (startTaskState) mainSession.restoreTaskStateSnapshot(startTaskState)
        taskPlanRolledBack = true
      }
      if (taskBoundaryStarted) {
        await this.persistTaskEnd(taskId, outcome, this.snapshotState())
      }
      if (taskPlanRolledBack) {
        emit({ type: 'task-plan-restored', plan: startTaskState?.activePlan ?? null })
      }
      if (!keepsConsensusProgress(outcome) && this.pendingTexts.length > 0) {
        const pending = this.pendingTexts.splice(0)
        await this.restoreQueuedMessages(pending)
      }
      this.restoreExecution()
      mainSession.setUserQuestionsEnabled(true)
      mainSession.setTerminalStatusManaged(false)
      this.peers = []
      this.peerPhase = false
      this.executionPhase = false
      this.running = false
      // 收尾兜底：此时无任何在跑的回合，状态归位（对 UI 幂等）
      emit({ type: 'agent-status', status: 'idle' })
      const nextTask = this.deferredTaskMessages.shift()
      if (nextTask) {
        await this.deliverDeferredMessage(nextTask)
      }
    }
  }

  /** quick_review：B、C 并行快评 → 执行包（协议 §1.2；不更新 session_score） */
  private async runQuickReview(
    userText: string,
    m1: CandidateContent | null,
    taskId: string,
    agentDirs: Record<ConsensusAgentId, string>,
    digest: string,
  ): Promise<string | null> {
    const { emit } = this.options
    const spec = {
      round: 1 as const,
      kind: 'quick' as const,
      mustVote: ['M1'],
      existingCandidateIds: ['M1'],
      requireProtocolMode: false,
    }
    const run = async (agentId: 'B' | 'C') => {
      const peer = this.makePeer(agentId, agentDirs[agentId])
      const result = await peer.runRound(
        buildQuickReviewPrompt(agentId, userText, m1, digest + formatMemories(this.memories[agentId])),
        { ...spec, agentId },
      )
      return { agentId, result }
    }
    const reviews = await Promise.all([run('B'), run('C')])
    if (this.aborted) return null
    this.saveMemories(
      taskId,
      reviews.filter((r) => r.result.ok).map((r) => (r.result as { ok: true; output: ProtocolOutput }).output),
    )

    for (const r of reviews) {
      if (r.result.ok) {
        const vote = r.result.output.votes[0]!
        emit({
          type: 'vote-cast',
          from: r.agentId,
          target: vote.target,
          vote: vote.vote,
          reason: vote.reason,
          suggestedChange: vote.suggestedChange,
        })
      }
    }

    // accept 与 accept_with_minor_edits 都算接受；invalid 视为未接受（Main 终判兜底）
    const bothAccept = reviews.every(
      (r) => r.result.ok && r.result.output.votes[0]!.vote !== 'reject',
    )
    emit({
      type: 'negotiation-decided',
      taskId,
      selectedCandidateIds: ['M1'],
      reason: bothAccept ? 'B/C 均接受 M1，Main 评估意见后执行' : '评审存在异议，由 Main 终判后执行',
    })

    const lines = [
      bothAccept ? '[协商结果 · execution_allowed]' : '[协商结果 · 需要你终判]',
      bothAccept
        ? 'B/C 均接受你的 M1。请客观评估以下评审意见（minor 修改建议可采纳、部分采纳或拒绝），然后执行最终方案。'
        : 'B/C 快评未全部接受 M1。请自行判断是否采纳以下意见（可采纳、部分采纳或不采纳），形成最终方案并执行。',
      '',
    ]
    for (const r of reviews) {
      if (!r.result.ok) {
        lines.push(`- Agent ${r.agentId}：未能给出有效评审（${r.result.error}）`)
        continue
      }
      const v = r.result.output.votes[0]!
      lines.push(`- Agent ${r.agentId}：${v.vote} —— ${v.reason}`)
      if (v.suggestedChange) lines.push(`  建议修改：${v.suggestedChange}`)
    }
    lines.push('', '你已恢复正常执行权限，现在开始执行。')
    return lines.join('\n')
  }

  /** 任务结束：从 B/C 本任务的协议输出提取记忆（协议 §10：随后 Peer 会话即被丢弃） */
  private saveMemories(taskId: string, outputs: ProtocolOutput[]): void {
    for (const agentId of ['B', 'C'] as const) {
      const own = outputs.filter((o) => o.agentId === agentId)
      if (own.length > 0) {
        this.memories[agentId].push(extractMemorySummary(agentId, taskId, own))
      }
    }
  }

  /** 创建受限讨论 Agent：过程流包进 peer-event，审批请求带身份前缀防 requestId 撞车 */
  private makePeer(agentId: 'B' | 'C', scratchDir: string): PeerAgent {
    const { emit, requestApproval } = this.options
    const peer = new PeerAgent({
      agentId,
      ...this.options.agents[agentId],
      projectDir: this.options.projectDir,
      scratchDir,
      osPlatform: this.options.osPlatform,
      homeDir: this.options.homeDir,
      emit: (event: CoreEvent) => emit({ type: 'peer-event', agentId, event }),
      requestApproval: (req) =>
        requestApproval({
          ...req,
          requestId: `${agentId}-${req.requestId}`,
          reason: `[Agent ${agentId}] ${req.reason}`,
        }),
    })
    this.peers.push(peer)
    return peer
  }

  /** B/C 期间的补充保持独立消息顺序，附件只在 Main 执行边界解引用。 */
  private takePendingInputs(
    packageText: string,
    rootSkills: readonly ActivatedSkill[] = [],
  ): { text: string; inputs: QueuedUserMessage[]; skills: ActivatedSkill[] } {
    if (this.pendingTexts.length === 0) {
      return { text: packageText, inputs: [], skills: cloneUniqueSkills(rootSkills) }
    }
    const pending = this.pendingTexts.splice(0)
    return {
      text: packageText,
      inputs: pending.map((input) => ({
        id: input.persistedInputId ?? input.id,
        text: input.text,
        ...(input.attachments.length ? { attachments: input.attachments } : {}),
        ...(input.attachments.length ? { imageDelivery: input.imageDelivery } : {}),
        ...(input.pdfAttachments.length ? { pdfAttachments: input.pdfAttachments } : {}),
        ...(input.skills.length ? { skills: input.skills.map(skillSummary) } : {}),
      })),
      skills: cloneUniqueSkills([
        ...rootSkills,
        ...pending.flatMap((input) => input.skills),
      ]),
    }
  }

  private coordinatorMessage(
    text: string,
    attachments: readonly ImageAttachment[],
    persistedInputId: string | undefined,
    pdfAttachments: readonly PdfAttachment[],
    skills: readonly ActivatedSkill[],
    imageDelivery?: ImageDeliveryMode,
  ): CoordinatorMessage {
    return {
      id: persistedInputId ?? `cq-${Date.now()}-${this.pendingTexts.length + this.deferredTaskMessages.length}`,
      ...(persistedInputId ? { persistedInputId } : {}),
      text,
      attachments: [...attachments],
      ...(attachments.length ? { imageDelivery: imageDelivery ?? 'native' } : {}),
      pdfAttachments: [...pdfAttachments],
      skills: skills.map((skill) => structuredClone(skill)),
    }
  }

  private emitQueued(message: CoordinatorMessage): void {
    this.options.emit({
      type: 'message-queued',
      id: message.id,
      text: message.text,
      ...(message.attachments.length ? { attachments: message.attachments } : {}),
      ...(message.pdfAttachments.length ? { pdfAttachments: message.pdfAttachments } : {}),
      ...(message.skills.length ? { skills: message.skills.map(skillSummary) } : {}),
    })
  }

  private interruptForDeferredInput(): void {
    this.aborted = true
    for (const peer of this.peers) peer.abort()
    this.options.mainSession.abort()
  }

  private async restoreQueuedMessages(messages: CoordinatorMessage[]): Promise<void> {
    if (messages.length === 0) return
    const persistedIds = messages.flatMap((message) =>
      message.persistedInputId ? [message.persistedInputId] : [])
    try {
      await this.options.onInputsRestored?.(persistedIds)
    } catch (error) {
      this.reportPersistenceError('队列恢复', error)
      // 事实源仍是 queued 时不能向 UI 宣称已恢复，否则下一次提交必然因身份状态不符失败。
      return
    }
    this.options.emit({
      type: 'queue-restored',
      text: messages.map((message) => message.text).join('\n'),
      items: messages.map((message) => ({
        id: message.id,
        text: message.text,
        ...(message.attachments.length ? { attachments: message.attachments } : {}),
        ...(message.pdfAttachments.length ? { pdfAttachments: message.pdfAttachments } : {}),
        ...(message.skills.length ? { skills: message.skills.map(skillSummary) } : {}),
      })),
    })
  }

  private async deliverDeferredMessage(message: CoordinatorMessage): Promise<void> {
    if (message.attachments.length > 0 || message.pdfAttachments.length > 0) {
      this.options.emit({
        type: 'consensus-skipped',
        reason: message.pdfAttachments.length > 0 ? 'pdf-input' : 'image-input',
      })
      if (!message.persistedInputId) {
        this.options.emit({
          type: 'message-injected',
          id: message.id,
          text: message.text,
          startsTurn: true,
          attachments: message.attachments,
          ...(message.pdfAttachments.length
            ? { pdfAttachments: message.pdfAttachments }
            : {}),
          ...(message.skills.length ? { skills: message.skills.map(skillSummary) } : {}),
        })
      }
      await this.options.mainSession.handleUserMessage(
        message.text,
        false,
        message.attachments,
        message.persistedInputId,
        message.pdfAttachments,
        message.skills,
        message.imageDelivery,
      )
      return
    }
    if (!message.persistedInputId) {
      this.options.emit({
        type: 'message-injected',
        id: message.id,
        text: message.text,
        startsTurn: true,
      })
    }
    await this.runTask(
      message.text,
      message.persistedInputId ? [message.persistedInputId] : [],
      message.skills,
    )
  }

  private restoreExecution(): void {
    this.options.mainSession.setDiscussion(null)
    this.options.mainSession.setExtraTools([])
  }

  private executionOutcome(stopReason: StopReason | void): ConsensusTaskOutcome {
    if (this.aborted || stopReason === 'aborted') return 'aborted'
    if (stopReason === 'max-turns') return 'max-turns'
    if (stopReason === 'paused') return 'paused'
    return stopReason === 'completed' ? 'completed' : 'error'
  }

  private snapshotState(): ConsensusPersistedState {
    return consensusPersistedStateSchema.parse({
      taskCounter: this.taskCounter,
      sessionScore: this.sessionScore,
      memories: this.memories,
      taskLog: this.taskLog,
    })
  }

  private restoreState(state: ConsensusPersistedState): void {
    const parsed = consensusPersistedStateSchema.parse(state)
    this.taskCounter = parsed.taskCounter
    this.sessionScore = parsed.sessionScore
    this.memories = parsed.memories
    this.taskLog = parsed.taskLog
  }

  private async persistTaskStart(
    taskId: string,
    state: ConsensusPersistedState,
    userText: string,
    deliveredInputIds: readonly string[],
    skills: readonly ActivatedSkill[],
  ): Promise<boolean> {
    try {
      await this.options.onTaskStart?.(taskId, state, userText, deliveredInputIds, skills)
      return true
    } catch (error) {
      this.reportPersistenceError('起点', error)
      return false
    }
  }

  private async persistTaskEnd(
    taskId: string,
    outcome: ConsensusTaskOutcome,
    state: ConsensusPersistedState,
  ): Promise<void> {
    try {
      await this.options.onTaskEnd?.(taskId, outcome, state)
    } catch (error) {
      this.reportPersistenceError('终点', error)
    }
  }

  private reportPersistenceError(boundary: string, error: unknown): void {
    this.options.emit({
      type: 'error',
      message: `共识任务${boundary}未能写入会话记录：${error instanceof Error ? error.message : String(error)}`,
      recoverable: true,
    })
  }
}

function cloneUniqueSkills(skills: readonly ActivatedSkill[]): ActivatedSkill[] {
  const unique = new Map<string, ActivatedSkill>()
  for (const skill of skills) unique.set(skill.id, structuredClone(skill))
  return [...unique.values()]
}
