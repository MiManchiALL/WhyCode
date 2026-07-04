import type { AgentSession, ApprovalHandler } from '../agent/session.ts'
import type { CoreEvent, CoreEventSink } from '../events.ts'
import type { ModelEntry, ProviderConfig } from '../providers/registry.ts'
import { PeerAgent } from './peer-agent.ts'
import { runProtocolRound } from './run-round.ts'
import { createTaskScratch } from './scratch.ts'
import type { CandidateContent, ProtocolOutput, Vote } from './types.ts'

export interface ConsensusAgentSetup {
  model: ModelEntry
  providerConfig: ProviderConfig
}

export interface ConsensusCoordinatorOptions {
  /** Main = 用户对话的既有会话（最终执行者，保留完整上下文） */
  mainSession: AgentSession
  projectDir: string
  /** scratch 存储根（宿主注入，如 userData/scratch） */
  scratchRoot: string
  conversationId: string
  agents: { B: ConsensusAgentSetup; C: ConsensusAgentSetup }
  osPlatform: NodeJS.Platform
  emit: CoreEventSink
  requestApproval: ApprovalHandler
}

/**
 * 协商协调器（M3-b：main_only + quick_review）。Orchestrator 是控制面代码非 LLM（协议 §4.3）：
 * 只管流程/模式锁定/输入包组装/事件广播，不判断方案质量。
 * 流程：Main 讨论档输出 M1（锁定 protocol_mode）→ main_only 直接放行执行 /
 * quick_review 时 B、C 并行快评 → 评审结果一次性注入 Main → Main 终判并执行（协议 §1.2）。
 */
export class ConsensusCoordinator {
  private options: ConsensusCoordinatorOptions
  private taskCounter = 0
  private peers: PeerAgent[] = []
  private running = false
  /** B/C 评审期间（Main 空闲）用户插话暂存，注入执行阶段输入包 */
  private pendingTexts: { id: string; text: string }[] = []
  private peerPhase = false
  private aborted = false

  constructor(options: ConsensusCoordinatorOptions) {
    this.options = options
  }

  get busy(): boolean {
    return this.running
  }

  /** 用户消息入口：空闲开新协商任务；Main 探索中走会话自身 steering；B/C 评审中暂存 */
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
    try {
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
        allowedModes: ['main_only', 'quick_review'], // full_consensus 待 M3-c 实现后放开
      })
      if (this.aborted) return
      if (!m1Result.ok) {
        emit({ type: 'error', message: `协商失败（Main 未产出 M1）：${m1Result.error}`, recoverable: true })
        return
      }
      const m1 = m1Result.output
      const mode = m1.protocolMode ?? 'main_only'
      emit({
        type: 'candidate-submitted',
        agentId: 'Main',
        candidateId: 'M1',
        summary: m1.candidate?.summary ?? '',
      })

      // main_only：无需评审，恢复执行档直接放行（协议 §6.1，行为与单 Agent 一致）
      if (mode === 'main_only') {
        this.restoreExecution()
        emit({ type: 'execution-started', taskId })
        await mainSession.handleUserMessage(
          '[协商] 协议模式 main_only 已锁定：无需评审。你已恢复正常执行权限，请直接完成用户请求；' +
            '若探索阶段已得出完整答案，直接给出最终回答即可，不要重复已说过的内容。',
        )
        return
      }

      // quick_review：B/C 并行快评 M1（协议 §1.2）；Main 已空闲，全局状态由协调器接管
      emit({ type: 'negotiation-started', taskId, mode })
      emit({ type: 'agent-status', status: 'working' })
      this.peerPhase = true
      const reviews = await this.runQuickReviews(userText, m1.candidate, scratch.agentDirs)
      this.peerPhase = false
      if (this.aborted) return

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

      // 计票：accept 与 accept_with_minor_edits 都算接受；invalid 视为未接受（Main 终判兜底）
      const bothAccept = reviews.every(
        (r) => r.result.ok && r.result.output.votes[0]!.vote !== 'reject',
      )
      emit({
        type: 'negotiation-decided',
        taskId,
        selectedCandidateIds: ['M1'],
        reason: bothAccept
          ? 'B/C 均接受 M1，Main 评估意见后执行'
          : '评审存在异议，由 Main 终判后执行',
      })

      // 执行阶段：评审结果一次性注入 Main（协议 §15.2），恢复执行档
      this.restoreExecution()
      emit({ type: 'execution-started', taskId })
      await mainSession.handleUserMessage(this.buildExecutionPackage(bothAccept, reviews))
    } catch (error) {
      emit({
        type: 'error',
        message: `协商流程异常：${error instanceof Error ? error.message : String(error)}`,
        recoverable: true,
      })
    } finally {
      this.restoreExecution()
      this.peers = []
      this.peerPhase = false
      this.running = false
      // 收尾兜底：此时无任何在跑的回合，状态归位（对 UI 幂等）
      emit({ type: 'agent-status', status: 'idle' })
    }
  }

  /** B、C 并行快评；单个失败不拖垮另一个（invalid 在终判中说明） */
  private async runQuickReviews(
    userText: string,
    m1: CandidateContent | null,
    agentDirs: Record<'Main' | 'B' | 'C', string>,
  ): Promise<QuickReview[]> {
    const { emit, requestApproval } = this.options
    const spec = {
      round: 1 as const,
      kind: 'quick' as const,
      mustVote: ['M1'],
      existingCandidateIds: ['M1'],
      requireProtocolMode: false,
    }
    const run = async (agentId: 'B' | 'C'): Promise<QuickReview> => {
      const peer = new PeerAgent({
        agentId,
        ...this.options.agents[agentId],
        projectDir: this.options.projectDir,
        scratchDir: agentDirs[agentId],
        osPlatform: this.options.osPlatform,
        // B/C 过程流包进 peer-event；审批请求带上身份前缀防 requestId 撞车
        emit: (event: CoreEvent) => emit({ type: 'peer-event', agentId, event }),
        requestApproval: (req) =>
          requestApproval({
            ...req,
            requestId: `${agentId}-${req.requestId}`,
            reason: `[Agent ${agentId}] ${req.reason}`,
          }),
      })
      this.peers.push(peer)
      const result = await peer.runRound(buildQuickReviewPrompt(agentId, userText, m1), {
        ...spec,
        agentId,
      })
      return { agentId, result }
    }
    return Promise.all([run('B'), run('C')])
  }

  private buildExecutionPackage(bothAccept: boolean, reviews: QuickReview[]): string {
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
    if (this.pendingTexts.length > 0) {
      lines.push('', '[用户在评审期间的补充]')
      for (const p of this.pendingTexts) {
        lines.push(p.text)
        this.options.emit({ type: 'message-injected', id: p.id, text: p.text })
      }
      this.pendingTexts = []
    }
    lines.push('', '你已恢复正常执行权限，现在开始执行。')
    return lines.join('\n')
  }

  private restoreExecution(): void {
    this.options.mainSession.setDiscussion(null)
    this.options.mainSession.setExtraTools([])
  }
}

interface QuickReview {
  agentId: 'B' | 'C'
  result: Awaited<ReturnType<PeerAgent['runRound']>>
}

function buildM1Prompt(userText: string): string {
  return [
    '[多 Agent 协商任务]',
    '用户请求：',
    userText,
    '',
    '请先做必要探索（当前为讨论阶段，不可修改项目），然后调用 SubmitProtocolOutput 提交候选 M1 并选定 protocol_mode：',
    '- main_only：简单任务（小范围修改/直接问答/低风险机械改动）——提交后你将恢复正常权限直接执行',
    '- quick_review：中等任务（单模块修复/小范围重构/方案选择）——B/C 将快速评审你的 M1，之后你综合意见执行',
    '选 quick_review 时 M1 只是处理思路（final_answer_or_plan 写清楚改什么、怎么改），提交前不要尝试执行任何修改。',
  ].join('\n')
}

function buildQuickReviewPrompt(
  agentId: 'B' | 'C',
  userText: string,
  m1: CandidateContent | null,
): string {
  const lines = [
    '[多 Agent 协商 · quick_review 快评]',
    '用户请求：',
    userText,
    '',
    'Main 的候选 M1：',
    `summary: ${m1?.summary ?? '（无）'}`,
    `final_answer_or_plan: ${m1?.finalAnswerOrPlan ?? '（无）'}`,
  ]
  if (m1?.evidenceRefs?.length) lines.push(`evidence_refs: ${m1.evidenceRefs.join('；')}`)
  if (m1?.scratchArtifacts?.length) {
    lines.push(`scratch_artifacts（Main 的实验产物，可读取参考，勿修改原件）: ${m1.scratchArtifacts.join('；')}`)
  }
  if (m1?.knownRisks?.length) lines.push(`known_risks: ${m1.knownRisks.join('；')}`)
  lines.push(
    '',
    `你的任务（Agent ${agentId}）：独立评价 M1 能否直接采用——必要时读代码/在你的临时工作区做小实验验证其关键论断。`,
    '完成后调用 SubmitProtocolOutput 提交对 M1 的投票（accept / accept_with_minor_edits / reject）。',
    '这是快评模式：不需要提出你自己的完整候选方案。',
  )
  return lines.join('\n')
}
