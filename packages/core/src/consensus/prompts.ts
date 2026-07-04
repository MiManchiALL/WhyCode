import type { CandidateContent } from './types.ts'

/** 协商各轮次的输入包模板（Orchestrator 组装上下文的唯一文案来源） */

export function buildM1Prompt(userText: string): string {
  return [
    '[多 Agent 协商任务]',
    '用户请求：',
    userText,
    '',
    '请先做必要探索（当前为讨论阶段，不可修改项目），然后调用 SubmitProtocolOutput 提交候选 M1 并选定 protocol_mode：',
    '- main_only：简单任务（小范围修改/直接问答/低风险机械改动）——提交后你将恢复正常权限直接执行',
    '- quick_review：中等任务（单模块修复/小范围重构/方案选择）——B/C 快速评审你的 M1，之后你综合意见执行',
    '- full_consensus：高风险任务（跨模块改动/架构设计/数据迁移/安全权限相关）——三 Agent 完整协商投票',
    '用户明确要求多 Agent 讨论、充分评审或共识决策时，必须选 full_consensus。',
    '选 quick_review / full_consensus 时 M1 只是处理思路（final_answer_or_plan 写清楚改什么、怎么改），提交前不要尝试执行任何修改。',
  ].join('\n')
}

export function buildQuickReviewPrompt(
  agentId: 'B' | 'C',
  userText: string,
  m1: CandidateContent | null,
): string {
  return [
    '[多 Agent 协商 · quick_review 快评]',
    '用户请求：',
    userText,
    '',
    candidateText('M1（Main 的候选）', m1),
    '',
    `你的任务（Agent ${agentId}）：独立评价 M1 能否直接采用——必要时读代码/在你的临时工作区做小实验验证其关键论断。`,
    '完成后调用 SubmitProtocolOutput 提交对 M1 的投票（accept / accept_with_minor_edits / reject）。',
    '这是快评模式：不需要提出你自己的完整候选方案。',
  ].join('\n')
}

export function buildRound1PeerPrompt(
  agentId: 'B' | 'C',
  userText: string,
  m1: CandidateContent | null,
): string {
  return [
    '[多 Agent 协商 · full_consensus 第一轮]',
    '用户请求：',
    userText,
    '',
    candidateText('M1（Main 的候选）', m1),
    '',
    `你的任务（Agent ${agentId}）：`,
    '1. 独立探索问题（读代码、在你的临时工作区实验）。不要被 M1 锚定——先形成自己的判断，再对照 M1。',
    `2. 调用 SubmitProtocolOutput 提交：对 M1 的投票（必须），以及你自己的候选方案 ${agentId}1（完整处理思路，可以支持 M1 的方向，也可以提出不同思路）。`,
  ].join('\n')
}

export function buildRound2MainPrompt(
  b1: CandidateContent | null,
  c1: CandidateContent | null,
): string {
  return [
    '[full_consensus 第二轮 · 修订你的候选]',
    '第一轮 B/C 未同时接受 M1。他们的候选如下：',
    '',
    candidateText('B1（Agent B 的候选）', b1),
    '',
    candidateText('C1（Agent C 的候选）', c1),
    '',
    '请阅读并按需继续探索，然后调用 SubmitProtocolOutput 提交修订候选 M2（可吸收 B1/C1 的合理部分，也可坚持并强化你的思路），并对 B1、C1 各投一票。',
  ].join('\n')
}

export function buildRound2PeerPrompt(
  agentId: 'B' | 'C',
  m2: CandidateContent | null,
  otherCandidate: CandidateContent | null,
  otherId: string,
): string {
  return [
    '[full_consensus 第二轮]',
    '',
    candidateText('M2（Main 的修订候选）', m2),
    '',
    candidateText(`${otherId}（另一位评审者的第一轮候选）`, otherCandidate),
    '',
    `请按需继续探索，然后调用 SubmitProtocolOutput 提交你的第二轮候选 ${agentId}2（可坚持你的第一轮思路、修订它、或转向支持其他候选），并对 M2、${otherId} 各投一票。`,
  ].join('\n')
}

export function buildRound3MainPrompt(
  b2: CandidateContent | null,
  c2: CandidateContent | null,
): string {
  return [
    '[full_consensus 第三轮 · 最终兜底]',
    '第二轮没有候选获得 2 票。B/C 的第二轮候选如下：',
    '',
    candidateText('B2（Agent B 的第二轮候选）', b2),
    '',
    candidateText('C2（Agent C 的第二轮候选）', c2),
    '',
    '请调用 SubmitProtocolOutput 提交最终候选 M3——可采纳、部分采纳或不采纳 B2/C2，由你自行判断；M3 将直接进入执行阶段。',
  ].join('\n')
}

/** 候选内容的统一文本化（输入包用；scratch_artifacts 只传路径不注入全文，协议 §7.2） */
export function candidateText(title: string, c: CandidateContent | null): string {
  if (!c) return `${title}：（无有效候选）`
  const lines = [`${title}：`, `summary: ${c.summary}`, `final_answer_or_plan: ${c.finalAnswerOrPlan}`]
  if (c.evidenceRefs?.length) lines.push(`evidence_refs: ${c.evidenceRefs.join('；')}`)
  if (c.scratchArtifacts?.length) {
    lines.push(`scratch_artifacts（实验产物路径，可读取参考，勿修改原件）: ${c.scratchArtifacts.join('；')}`)
  }
  if (c.knownRisks?.length) lines.push(`known_risks: ${c.knownRisks.join('；')}`)
  return lines.join('\n')
}
