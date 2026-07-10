import type { AgentSession } from '../agent/session.ts'
import type { CoreEventSink } from '../events.ts'
import type { PeerAgent } from './peer-agent.ts'
import { runProtocolRound } from './run-round.ts'
import {
  buildIndependentNotePrompt,
  buildRound1PeerPrompt,
  buildRound2MainPrompt,
  buildRound2PeerPrompt,
  buildRound3MainPrompt,
  candidateText,
} from './prompts.ts'
import type { ConsensusAgentId, ProtocolOutput, Vote } from './types.ts'

/**
 * full_consensus 三轮驱动（协议 §8，含 §9 独立初判）。返回执行包文本与全部协议输出
 * （协调器据此提取 B/C 记忆）；aborted 返回 null。
 * 任一协议输出 invalid 时走降级路径：把已有材料交 Main 终判（保证永不卡死）。
 */
export interface FullConsensusDeps {
  emit: CoreEventSink
  mainSession: AgentSession
  makePeer: (agentId: 'B' | 'C') => PeerAgent
  taskId: string
  userText: string
  m1: ProtocolOutput
  /** 该 Agent 的历史记忆文本块（协议 §10；无记忆为空串） */
  memoryOf: (agentId: 'B' | 'C') => string
  /** 对话级累计分数（协调器持有，跨任务保留，新对话重置） */
  sessionScore: Record<ConsensusAgentId, number>
  isAborted: () => boolean
}

export interface FullConsensusResult {
  packageText: string
  /** candidateId → 协议输出（含降级时已收集的部分；协调器提取 B/C 记忆用） */
  outputs: Map<string, ProtocolOutput>
}

export async function runFullConsensus(deps: FullConsensusDeps): Promise<FullConsensusResult | null> {
  const { emit, mainSession, taskId, sessionScore } = deps
  /** 候选登记表：candidateId → 输出（投票目标校验与执行包组装的依据） */
  const outputs = new Map<string, ProtocolOutput>()
  outputs.set('M1', deps.m1)

  // ---------- 第一轮：独立初判（§9，看到 M1 前先形成判断）→ 评 M1 + 各自候选 ----------
  const peerB = deps.makePeer('B')
  const peerC = deps.makePeer('C')
  const r1Spec = {
    round: 1 as const,
    kind: 'full' as const,
    mustVote: ['M1'],
    existingCandidateIds: ['M1'],
    requireProtocolMode: false,
  }
  const runPeerRound1 = async (peer: PeerAgent, agentId: 'B' | 'C') => {
    await peer.explore(buildIndependentNotePrompt(agentId, deps.userText, deps.memoryOf(agentId)))
    if (deps.isAborted()) return { ok: false as const, error: 'aborted' }
    return peer.runRound(buildRound1PeerPrompt(agentId, deps.userText, deps.m1.candidate), {
      ...r1Spec,
      agentId,
    })
  }
  const [b1r, c1r] = await Promise.all([runPeerRound1(peerB, 'B'), runPeerRound1(peerC, 'C')])
  if (deps.isAborted()) return null
  if (!b1r.ok || !c1r.ok) {
    return degrade(deps, outputs, `第一轮存在无效输出（B:${b1r.ok ? '有效' : b1r.error}；C:${c1r.ok ? '有效' : c1r.error}）`)
  }
  outputs.set('B1', b1r.output)
  outputs.set('C1', c1r.output)
  announce(emit, 'B1', b1r.output)
  announce(emit, 'C1', c1r.output)

  if (passesRound1(b1r.output, c1r.output)) {
    sessionScore.Main += 1
    emit({
      type: 'negotiation-decided',
      taskId,
      selectedCandidateIds: ['M1'],
      reason: '第一轮通过：B/C 均接受 M1（Main +1 分）',
      scores: { ...sessionScore },
    })
    return buildPackage(
      outputs,
      [{ candidateId: 'M1', output: deps.m1, votes: votesOn('M1', [b1r.output, c1r.output]) }],
      'B/C 均接受 M1。请评估支持票中的 suggested_change（可采纳/部分采纳/拒绝），合成最终方案并执行。',
    )
  }

  // ---------- 第二轮：Main 修订 → B/C 并行（协议 §8.2 的输入分发） ----------
  emit({ type: 'round-started', taskId, round: 2 })
  const m2r = await runProtocolRound(
    mainSession,
    buildRound2MainPrompt(b1r.output.candidate, c1r.output.candidate),
    {
      agentId: 'Main',
      round: 2,
      kind: 'full',
      mustVote: ['B1', 'C1'],
      existingCandidateIds: ['M1', 'B1', 'C1'],
      requireProtocolMode: false,
    },
  )
  if (deps.isAborted()) return null
  if (!m2r.ok) return degrade(deps, outputs, `第二轮 Main 输出无效（${m2r.error}）`)
  outputs.set('M2', m2r.output)
  announce(emit, 'M2', m2r.output)

  const r2Spec = {
    round: 2 as const,
    kind: 'full' as const,
    existingCandidateIds: ['M1', 'B1', 'C1', 'M2'],
    requireProtocolMode: false,
  }
  const [b2r, c2r] = await Promise.all([
    peerB.runRound(buildRound2PeerPrompt('B', m2r.output.candidate, c1r.output.candidate, 'C1'), {
      ...r2Spec,
      agentId: 'B',
      mustVote: ['M2', 'C1'],
    }),
    peerC.runRound(buildRound2PeerPrompt('C', m2r.output.candidate, b1r.output.candidate, 'B1'), {
      ...r2Spec,
      agentId: 'C',
      mustVote: ['M2', 'B1'],
    }),
  ])
  if (deps.isAborted()) return null
  if (!b2r.ok || !c2r.ok) {
    return degrade(deps, outputs, `第二轮存在无效输出（B:${b2r.ok ? '有效' : b2r.error}；C:${c2r.ok ? '有效' : c2r.error}）`)
  }
  outputs.set('B2', b2r.output)
  outputs.set('C2', c2r.output)
  announce(emit, 'B2', b2r.output)
  announce(emit, 'C2', c2r.output)

  const tally = countRound2Votes(m2r.output, b2r.output, c2r.output)
  const selected = (Object.keys(tally) as (keyof typeof tally)[]).filter((id) => tally[id] >= 2)

  if (selected.length > 0) {
    for (const id of selected) sessionScore[OWNER[id]!] += 1
    emit({
      type: 'negotiation-decided',
      taskId,
      selectedCandidateIds: [...selected],
      reason: `第二轮通过：${selected.join('、')} 获得 2 票（所属 Agent 各 +1 分）`,
      scores: { ...sessionScore },
    })
    const sources: Record<'M2' | 'B1' | 'C1', ProtocolOutput[]> = {
      M2: [b2r.output, c2r.output],
      B1: [m2r.output, c2r.output],
      C1: [m2r.output, b2r.output],
    }
    return buildPackage(
      outputs,
      selected.map((id) => ({ candidateId: id, output: outputs.get(id)!, votes: votesOn(id, sources[id]) })),
      selected.length > 1
        ? '多个候选获得 2 票：优先合并兼容部分；实现细节冲突时由你判断解决，形成一个可执行的最终方案。来自 B/C 的候选必须保持其核心方向，不得反向覆盖。'
        : selected[0] === 'M2'
          ? '你的 M2 获得共识。请评估支持票中的 suggested_change 后合成最终方案并执行。'
          : `${selected[0]} 获得共识（来自 ${OWNER[selected[0]!]}）。请保持该候选的整体方向合成完整方案——可加入你的执行建议，但不得反向覆盖其核心思路。`,
    )
  }

  // ---------- 第三轮：分数兜底（协议 §8.4） ----------
  emit({ type: 'round-started', taskId, round: 3 })
  const winner = round3Winner(sessionScore)
  if (winner) {
    const candidateId = `${winner}2`
    emit({
      type: 'negotiation-decided',
      taskId,
      selectedCandidateIds: [candidateId],
      reason: `第三轮兜底：无候选获得 2 票，按历史分采用 ${candidateId}（${winner} 分数明显高于 Main；本轮不加分）`,
      scores: { ...sessionScore },
    })
    return buildPackage(
      outputs,
      [{ candidateId, output: outputs.get(candidateId)!, votes: [] }],
      `按对话内历史分数采用 ${candidateId}（无支持票）。请保持其整体方向合成完整方案并执行——可加入你的执行建议，不得反向覆盖其核心思路。`,
    )
  }

  const m3r = await runProtocolRound(
    mainSession,
    buildRound3MainPrompt(b2r.output.candidate, c2r.output.candidate),
    {
      agentId: 'Main',
      round: 3,
      kind: 'full',
      mustVote: [],
      existingCandidateIds: ['M1', 'B1', 'C1', 'M2', 'B2', 'C2'],
      requireProtocolMode: false,
    },
  )
  if (deps.isAborted()) return null
  if (!m3r.ok) return degrade(deps, outputs, `第三轮 Main 输出无效（${m3r.error}）`)
  outputs.set('M3', m3r.output)
  announce(emit, 'M3', m3r.output)
  emit({
    type: 'negotiation-decided',
    taskId,
    selectedCandidateIds: ['M3'],
    reason: '第三轮兜底：Main 分数不低于 B/C，采用 Main 的最终候选 M3（本轮不加分）',
    scores: { ...sessionScore },
  })
  return buildPackage(
    outputs,
    [{ candidateId: 'M3', output: m3r.output, votes: [] }],
    '你的最终候选 M3 已被采用，请直接执行。',
  )
}

// ---------- 纯决策函数（协议规则，离线可测） ----------

const OWNER: Record<string, ConsensusAgentId> = { M1: 'Main', M2: 'Main', M3: 'Main', B1: 'B', B2: 'B', C1: 'C', C2: 'C' }

/** 第一轮通过条件：B、C 对 M1 都投非 reject（协议 §8.1） */
export function passesRound1(b1: ProtocolOutput, c1: ProtocolOutput): boolean {
  return [b1, c1].every((o) => {
    const v = o.votes.find((x) => x.target === 'M1')
    return v !== undefined && v.vote !== 'reject'
  })
}

/** 第二轮计票（协议 §8.2）：M2←B/C 票；B1←Main/C 票；C1←Main/B 票；accept 与 minor_edits 均计 1 */
export function countRound2Votes(
  m2: ProtocolOutput,
  b2: ProtocolOutput,
  c2: ProtocolOutput,
): Record<'M2' | 'B1' | 'C1', number> {
  const count = (target: string, sources: ProtocolOutput[]) =>
    sources.filter((o) => {
      const v = o.votes.find((x) => x.target === target)
      return v !== undefined && v.vote !== 'reject'
    }).length
  return {
    M2: count('M2', [b2, c2]),
    B1: count('B1', [m2, c2]),
    C1: count('C1', [m2, b2]),
  }
}

/** 第三轮分数兜底（协议 §8.4）：B/C 中分数 >= Main+1 者胜出，双双达标取分高者，平分取 B；否则 null=Main 终判 */
export function round3Winner(score: Record<ConsensusAgentId, number>): 'B' | 'C' | null {
  const qualified = (['B', 'C'] as const).filter((id) => score[id] >= score.Main + 1)
  if (qualified.length === 0) return null
  if (qualified.length === 1) return qualified[0]!
  return score.B >= score.C ? 'B' : 'C'
}

// ---------- 内部工具 ----------

/** 广播候选与其投票（UI 主线通知 + 卡片收口） */
function announce(emit: CoreEventSink, candidateId: string, output: ProtocolOutput): void {
  if (output.candidate) {
    emit({
      type: 'candidate-submitted',
      agentId: output.agentId,
      candidateId,
      summary: output.candidate.summary,
      details: {
        finalAnswerOrPlan: output.candidate.finalAnswerOrPlan,
        evidenceRefs: output.candidate.evidenceRefs,
        knownRisks: output.candidate.knownRisks,
      },
    })
  }
  for (const v of output.votes) {
    emit({ type: 'vote-cast', from: v.from, target: v.target, vote: v.vote, reason: v.reason, suggestedChange: v.suggestedChange })
  }
}

function votesOn(target: string, sources: ProtocolOutput[]): Vote[] {
  return sources.flatMap((o) => o.votes.filter((v) => v.target === target && v.vote !== 'reject'))
}

/** 执行阶段输入包（协议 §15.2 文本化） */
function buildPackage(
  outputs: Map<string, ProtocolOutput>,
  selected: { candidateId: string; output: ProtocolOutput; votes: Vote[] }[],
  instruction: string,
): FullConsensusResult {
  const lines = ['[协商结果 · execution_allowed]', instruction, '']
  for (const s of selected) {
    lines.push(candidateText(`被选中候选 ${s.candidateId}（${OWNER[s.candidateId]}）`, s.output.candidate))
    for (const v of s.votes) {
      lines.push(`  支持票 ${v.from}：${v.vote}｜${v.reason}${v.suggestedChange ? `｜建议：${v.suggestedChange}` : ''}`)
    }
    lines.push('')
  }
  lines.push('你已恢复正常执行权限，现在开始执行。')
  return { packageText: lines.join('\n'), outputs }
}

/** 降级路径：协议输出 invalid 时把已有材料交 Main 终判（协议 §14 精神：可追责且不卡死） */
function degrade(
  deps: FullConsensusDeps,
  outputs: Map<string, ProtocolOutput>,
  why: string,
): FullConsensusResult {
  deps.emit({ type: 'error', message: `full_consensus 降级为 Main 终判：${why}`, recoverable: true })
  deps.emit({
    type: 'negotiation-decided',
    taskId: deps.taskId,
    selectedCandidateIds: [],
    reason: `协商降级（${why}），由 Main 综合已有材料终判执行`,
    scores: { ...deps.sessionScore },
  })
  const lines = [
    '[协商结果 · 降级终判]',
    `协商未能正常完成（${why}）。以下是已收集到的候选材料，请你综合判断形成最终方案并执行：`,
    '',
  ]
  for (const [id, o] of outputs) {
    if (id === 'M1') continue // Main 自己的历史上下文里已有
    lines.push(candidateText(`候选 ${id}（${OWNER[id]}）`, o.candidate))
    lines.push('')
  }
  lines.push('你已恢复正常执行权限，现在开始执行。')
  return { packageText: lines.join('\n'), outputs }
}
