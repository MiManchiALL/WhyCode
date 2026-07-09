import type { CandidateContent } from './types.ts'

/** 协商各轮次的输入包模板（Orchestrator 组装上下文的唯一文案来源） */

export function buildM1Prompt(userText: string): string {
  return [
    '[多 Agent 协商任务]',
    '用户请求：',
    userText,
    '',
    '请先做必要分析（当前为讨论阶段，不可修改项目）。项目相关任务应按需查看真实代码；通用问题直接围绕问题本身推理，不要强行关联项目。然后调用 SubmitProtocolOutput 提交候选 M1 并选定 protocol_mode：',
    '- main_only：简单任务（直接问答、小范围修改、低风险机械操作）——提交后你将恢复正常权限直接处理',
    '- quick_review：中等任务（需要比较取舍、快速复核或小范围方案选择）——B/C 快速评审你的 M1，之后你综合意见处理',
    '- full_consensus：高风险或用户明确要求充分讨论的任务——三 Agent 完整协商投票',
    '用户明确要求多 Agent 讨论、充分评审或共识决策时，必须选 full_consensus。',
    '候选内容必须是你对任务本身的实质分析：summary 概括核心结论，final_answer_or_plan 写清事实判断、依据和处理方向。',
    '禁止用“用户要求三个 Agent”“采用 full_consensus”“将进行协商/投票”等流程复述代替任务分析。',
    '选 quick_review / full_consensus 时 M1 只是处理思路（final_answer_or_plan 写清楚改什么、怎么改），提交前不要尝试执行任何修改。',
  ].join('\n')
}

/** main_only 的协议内容不直接展示，执行回合必须重新交付一份完整的用户答案。 */
export function buildMainOnlyExecutionPrompt(
  userText: string,
  m1: CandidateContent | null,
): string {
  return [
    '[协商控制 · main_only 正式处理]',
    '协议阶段只用于内部判断，用户没有看到 M1 的详细内容。',
    '用户原始请求：',
    userText,
    '',
    candidateText('内部 M1（仅供你执行参考）', m1),
    '',
    '你已恢复正常执行权限。现在直接完成用户请求：',
    '- 问答、解释或项目分析：给出完整、自包含、可独立阅读的最终答案，不能只给收尾句。',
    '- 需要修改代码：按 M1 执行必要操作、验证结果，再向用户报告完成情况。',
    '- 不得使用“如上、前面已经说明、无需重复”等指代，因为协议内容没有展示给用户。',
  ].join('\n')
}

export function buildQuickReviewPrompt(
  agentId: 'B' | 'C',
  userText: string,
  m1: CandidateContent | null,
  memoryBlock = '',
): string {
  return [
    memoryBlock + '[多 Agent 协商 · quick_review 快评]',
    '用户请求：',
    userText,
    '',
    candidateText('M1（Main 的候选）', m1),
    '',
    `你的任务（Agent ${agentId}）：独立评价 M1 能否直接采用。按问题性质核实关键事实；仅当任务确实涉及当前项目时才读代码或做实验。`,
    '完成后调用 SubmitProtocolOutput 提交对 M1 的投票（accept / accept_with_minor_edits / reject）。',
    '这是快评模式：不需要提出你自己的完整候选方案。',
  ].join('\n')
}

/** 独立初判（协议 §9）：B/C 在看到 M1 之前先形成自己的判断，防锚定；不参与计票 */
export function buildIndependentNotePrompt(
  agentId: 'B' | 'C',
  userText: string,
  memoryBlock = '',
): string {
  return [
    memoryBlock + '[多 Agent 协商 · full_consensus 独立初判]',
    '用户请求：',
    userText,
    '',
    `你的任务（Agent ${agentId}）：在看到任何其他 Agent 的方案**之前**，独立分析这个问题（项目任务按需读代码，通用问题直接推理），`,
    '用普通文本简要写下你的初步判断：问题根因/关键取舍/你倾向的处理方向。',
    '这一步不是正式协议输出，不要调用 SubmitProtocolOutput——写完初判即结束本回合，稍后你会收到待评审的候选。',
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
    '1. 基于你刚才的独立初判对照评估 M1，必要时补充探索。',
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

const DIGEST_KEEP = 6
const DIGEST_CLIP = 120

/**
 * 对话脉络摘要（协议 §4.3「必要上下文」）：B/C 不保留普通轮次的会话，
 * 用户请求若指代此前对话（"刚才那个函数"），靠这里补齐脉络。
 */
export function buildConversationDigest(
  entries: { taskId: string; userText: string; m1Summary: string }[],
): string {
  if (entries.length === 0) return ''
  const clip = (s: string) => (s.length > DIGEST_CLIP ? s.slice(0, DIGEST_CLIP) + '…' : s)
  const lines = ['[本对话此前的任务脉络]']
  for (const e of entries.slice(-DIGEST_KEEP)) {
    lines.push(`- ${e.taskId}：用户「${clip(e.userText)}」→ Main 结论「${clip(e.m1Summary)}」`)
  }
  lines.push('')
  return lines.join('\n')
}
