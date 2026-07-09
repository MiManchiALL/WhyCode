import type { AgentMemorySummary, ConsensusAgentId, ProtocolOutput } from './types.ts'

/**
 * B/C 跨任务记忆（协议 §10 定案，文档一 §3.3）：任务结束丢弃整个会话，
 * 只保留从协议输出直接提取的结构化 memory_summary（零额外 LLM 调用）；
 * 下个任务激活时注入首轮输入包。
 */
export function extractMemorySummary(
  agentId: ConsensusAgentId,
  taskId: string,
  ownOutputs: ProtocolOutput[],
): AgentMemorySummary {
  const votes = ownOutputs.flatMap((o) => o.votes)
  const lastCandidate = [...ownOutputs].reverse().find((o) => o.candidate)?.candidate
  return {
    agentId,
    taskId,
    // 立场 = 最终候选摘要；快评模式无候选则取投票理由
    stance: lastCandidate?.summary ?? votes.at(-1)?.reason ?? '',
    supportedCandidates: [...new Set(votes.filter((v) => v.vote !== 'reject').map((v) => v.target))],
    rejectedCandidates: [...new Set(votes.filter((v) => v.vote === 'reject').map((v) => v.target))],
    importantSuggestions: votes.map((v) => v.suggestedChange).filter((s): s is string => Boolean(s?.trim())),
    evidenceRefs: lastCandidate?.evidenceRefs ?? [],
  }
}

/** 历次记忆 → 注入下个任务首轮输入包的文本块（无记忆返回空串） */
export function formatMemories(memories: AgentMemorySummary[]): string {
  if (memories.length === 0) return ''
  const lines = ['[你在本对话中此前任务的立场记忆]']
  for (const m of memories) {
    lines.push(`- ${m.taskId}：${m.stance}`)
    if (m.supportedCandidates.length) lines.push(`  支持过：${m.supportedCandidates.join('、')}`)
    if (m.rejectedCandidates.length) lines.push(`  反对过：${m.rejectedCandidates.join('、')}`)
    if (m.importantSuggestions.length) lines.push(`  关键建议：${m.importantSuggestions.join('；')}`)
    if (m.evidenceRefs.length) lines.push(`  证据：${m.evidenceRefs.join('；')}`)
  }
  lines.push('以上仅供延续判断脉络，本任务仍须独立探索。', '')
  return lines.join('\n')
}
