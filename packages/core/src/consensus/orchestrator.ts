import type { AgentSession, ApprovalHandler } from '../agent/session.ts'
import type { CoreEvent, CoreEventSink } from '../events.ts'
import type { ModelEntry, ProviderConfig } from '../providers/registry.ts'
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
import { createTaskScratch } from './scratch.ts'
import {
  consensusPersistedStateSchema,
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
  /充分讨论|多视角|多角度|互相评价|互相讨论|达成共识|完整共识|共识决策|你们.{0,4}讨论|大家.{0,6}讨论|一起讨论|三个\s*agent|多个\s*agent|full[_\s-]?consensus/i

/** 硬性风险触发词（协议 §1.1：高风险任务必须 full_consensus；保守收窄，避免误伤日常任务） */
const HARD_RISK_RE = /(数据库|数据)\s*迁移|删库|生产环境|支付|payment/i

export interface ConsensusCoordinatorOptions {
  /** Main = 用户对话的既有会话（最终执行者，保留完整上下文） */
  mainSession: AgentSession
  projectDir: string | null
  /** scratch 存储根（宿主注入，如 userData/scratch） */
  scratchRoot: string
  conversationId: string
  agents: { B: ConsensusAgentSetup; C: ConsensusAgentSetup }
  osPlatform: NodeJS.Platform
  emit: CoreEventSink
  requestApproval: ApprovalHandler
  /** M4：只恢复上一任务已提交的稳定状态，不恢复 Peer 会话或半截协议。 */
  initialState?: ConsensusPersistedState | null
  onTaskStart?: (taskId: string, state: ConsensusPersistedState) => Promise<void>
  onTaskEnd?: (
    taskId: string,
    outcome: ConsensusTaskOutcome,
    state: ConsensusPersistedState,
  ) => Promise<void>
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
  private pendingTexts: { id: string; text: string }[] = []
  private peerPhase = false
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

  /** 用户消息入口：空闲开新协商任务；Main 探索中走会话自身 steering；B/C 工作中暂存 */
  handleUserMessage(text: string, urgent = false): Promise<void> | void {
    if (!this.running) return this.runTask(text)
    if (this.peerPhase) {
      const id = `cq-${Date.now()}-${this.pendingTexts.length}`
      this.pendingTexts.push({ id, text })
      this.options.emit({ type: 'message-queued', id, text })
      return
    }
    return this.options.mainSession.handleUserMessage(text, urgent)
  }

  /** 取消整个协商（含 B/C）；暂存的插话文本还给输入框 */
  abort(): void {
    this.aborted = true
    for (const peer of this.peers) peer.abort()
    this.options.mainSession.abort()
    if (this.pendingTexts.length > 0) {
      this.options.emit({
        type: 'queue-restored',
        text: this.pendingTexts.map((p) => p.text).join('\n'),
      })
      this.pendingTexts = []
    }
  }

  private async runTask(userText: string): Promise<void> {
    const { mainSession, emit } = this.options
    this.running = true
    this.aborted = false
    const taskId = `task-${++this.taskCounter}`
    const startState = this.snapshotState()
    const startMessages = mainSession.captureMessageSnapshot()
    let outcome: ConsensusTaskOutcome = 'error'
    let taskBoundaryStarted = false
    try {
      taskBoundaryStarted = await this.persistTaskStart(taskId, startState)
      if (!taskBoundaryStarted) return
      const scratch = await createTaskScratch(
        this.options.scratchRoot,
        this.options.conversationId,
        taskId,
      )

      // 第一步：Main 讨论档输出 M1 + protocol_mode（协议 §1.1：模式只出现在首个 M1）
      mainSession.setDiscussion({ agentId: 'Main', scratchDir: scratch.agentDirs.Main })
      const m1Result = await runProtocolRound(mainSession, buildM1Prompt(userText), {
        agentId: 'Main',
        round: 1,
        kind: 'full',
        mustVote: [],
        existingCandidateIds: [],
        requireProtocolMode: true,
      })
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
      let mode = m1.protocolMode ?? 'main_only'
      if (mode !== 'full_consensus' && (EXPLICIT_CONSENSUS_RE.test(userText) || HARD_RISK_RE.test(userText))) {
        mode = 'full_consensus'
      }
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
        await mainSession.handleUserMessage(buildMainOnlyExecutionPrompt(userText, m1.candidate))
        outcome = this.aborted ? 'aborted' : 'completed'
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
      await mainSession.handleUserMessage(this.appendPendingTexts(packageText))
      outcome = this.aborted ? 'aborted' : 'completed'
    } catch (error) {
      emit({
        type: 'error',
        message: `协商流程异常：${error instanceof Error ? error.message : String(error)}`,
        recoverable: true,
      })
    } finally {
      if (outcome !== 'completed') {
        this.restoreState(startState)
        mainSession.restoreMessageSnapshot(startMessages)
      }
      if (taskBoundaryStarted) {
        await this.persistTaskEnd(taskId, outcome, this.snapshotState())
      }
      this.restoreExecution()
      this.peers = []
      this.peerPhase = false
      this.running = false
      // 收尾兜底：此时无任何在跑的回合，状态归位（对 UI 幂等）
      emit({ type: 'agent-status', status: 'idle' })
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

  /** 把 B/C 工作期间暂存的用户插话拼进执行包 */
  private appendPendingTexts(packageText: string): string {
    if (this.pendingTexts.length === 0) return packageText
    const lines = [packageText, '', '[用户在协商期间的补充]']
    for (const p of this.pendingTexts) {
      lines.push(p.text)
      this.options.emit({ type: 'message-injected', id: p.id, text: p.text })
    }
    this.pendingTexts = []
    return lines.join('\n')
  }

  private restoreExecution(): void {
    this.options.mainSession.setDiscussion(null)
    this.options.mainSession.setExtraTools([])
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
  ): Promise<boolean> {
    try {
      await this.options.onTaskStart?.(taskId, state)
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
