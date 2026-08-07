/**
 * 多 Agent 协商协议数据结构（M3；字段语义由编排器与契约测试共同维护）。
 * agent_id / round / candidate_id 由 Orchestrator 分配记录，不由模型自报（减少格式错误面）。
 */

import { z } from 'zod'

export type ConsensusAgentId = 'Main' | 'B' | 'C'

export type ProtocolMode = 'main_only' | 'quick_review' | 'full_consensus'

export type VoteValue = 'accept' | 'accept_with_minor_edits' | 'reject'

export interface Vote {
  /** 投票发起者 */
  from: ConsensusAgentId
  /** 已存在的候选 ID（M1/B1/C1/M2/B2/C2/M3） */
  target: string
  vote: VoteValue
  /** 为什么同意/不同意（协议 §14.3：必须非空） */
  reason: string
  /** 需要修改时怎么改（reject / accept_with_minor_edits 时必填） */
  suggestedChange?: string
}

export interface CandidateContent {
  summary: string
  finalAnswerOrPlan: string
  /** 关键证据：文件路径、测试结果、日志摘要 */
  evidenceRefs?: string[]
  /** 临时实验产物路径（scratch 内），只传路径不注入全文（协议 §7.2） */
  scratchArtifacts?: string[]
  knownRisks?: string[]
}

export interface Candidate {
  /** M1/B1/C1/M2/B2/C2/M3 */
  candidateId: string
  agentId: ConsensusAgentId
  round: 1 | 2 | 3
  content: CandidateContent
}

/** 一个 Agent 完成一轮探索后的正式协议输出（经 SubmitProtocolOutput 工具校验收集） */
export interface ProtocolOutput {
  agentId: ConsensusAgentId
  round: 1 | 2 | 3
  /** quick_review 的 B/C 只投票不出候选（协议 §1.2） */
  candidate: CandidateContent | null
  votes: Vote[]
  /** 仅当前 task 首个 M1 携带（协议 §1.1） */
  protocolMode?: ProtocolMode
}

/** 任务结束后 B/C 唯一保留的记忆（协议 §10 定案：任务内全量、任务间只留此结构） */
export interface AgentMemorySummary {
  agentId: ConsensusAgentId
  taskId: string
  stance: string
  supportedCandidates: string[]
  rejectedCandidates: string[]
  importantSuggestions: string[]
  evidenceRefs: string[]
}

const memorySummarySchema = z.object({
  agentId: z.enum(['Main', 'B', 'C']),
  taskId: z.string().min(1),
  stance: z.string(),
  supportedCandidates: z.array(z.string()),
  rejectedCandidates: z.array(z.string()),
  importantSuggestions: z.array(z.string()),
  evidenceRefs: z.array(z.string()),
})

/**
 * 跨任务唯一允许恢复的共识状态。任务内候选、投票原文和 Peer 会话都不进入这里，
 * 避免重启后误续跑半截协议或无限膨胀上下文。
 */
export const consensusPersistedStateSchema = z.object({
  taskCounter: z.number().int().nonnegative(),
  sessionScore: z.object({
    Main: z.number().int().nonnegative(),
    B: z.number().int().nonnegative(),
    C: z.number().int().nonnegative(),
  }),
  memories: z.object({
    B: z.array(memorySummarySchema),
    C: z.array(memorySummarySchema),
  }),
  taskLog: z.array(
    z.object({
      taskId: z.string().min(1),
      userText: z.string(),
      m1Summary: z.string(),
    }),
  ),
})

export type ConsensusPersistedState = z.infer<typeof consensusPersistedStateSchema>
export type ConsensusTaskOutcome = 'completed' | 'paused' | 'max-turns' | 'aborted' | 'error'

/** 正常完成、主动安全暂停和安全上限停止都保留进度；取消/异常才回滚事务。 */
export function keepsConsensusProgress(outcome: ConsensusTaskOutcome): boolean {
  return outcome === 'completed' || outcome === 'paused' || outcome === 'max-turns'
}
