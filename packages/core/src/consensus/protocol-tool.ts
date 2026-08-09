import { z } from 'zod'
import { buildTool, type ToolDefinition } from '../tools/tool.ts'
import type {
  ConsensusAgentId,
  ProtocolMode,
  ProtocolOutput,
  Vote,
  VoteValue,
} from './types.ts'

export const PROTOCOL_OUTPUT_TOOL_NAME = 'SubmitProtocolOutput'

const VOTE_VALUES = ['accept', 'accept_with_minor_edits', 'reject'] as const
const PROTOCOL_MODES = ['main_only', 'quick_review', 'full_consensus'] as const

/**
 * 一轮协议输出的动态规格（Orchestrator 按轮次/角色生成）。
 * agent_id/round/candidate_id 由控制面持有，不让模型自报（协议 §7 结构是建议，此处收窄错误面）。
 */
export interface ProtocolToolSpec {
  agentId: ConsensusAgentId
  round: 1 | 2 | 3
  /** quick=快评（只投 M1 不出候选，协议 §1.2）；full=完整候选+投票 */
  kind: 'quick' | 'full'
  /** 必须投票的候选 ID（协议 §8：如 B 第二轮必须投 M2 和 C1） */
  mustVote: string[]
  /** 可作为投票目标的已存在候选 ID（协议 §14.2：target 必须存在） */
  existingCandidateIds: string[]
  /** 当前 task 首个 M1：必须携带 protocol_mode（协议 §1.1） */
  requireProtocolMode: boolean
  /** 控制面已锁定模式时，schema 直接收窄，避免模型提交与实际流程不一致。 */
  forcedProtocolMode?: ProtocolMode
}

/**
 * 合成协议输出工具（机制借鉴 Claude Code StructuredOutput：schema 借 tool-calling 约束格式，
 * 工具层校验协议规则，不合规作为工具错误回传让模型自然重试）。
 * kind 标记为 read：无副作用，权限链自动放行、不拍快照。
 */
export function createProtocolOutputTool(
  spec: ProtocolToolSpec,
  onSubmit: (output: ProtocolOutput) => void,
): ToolDefinition {
  const targetEnum =
    spec.existingCandidateIds.length > 0
      ? z.enum(spec.existingCandidateIds as [string, ...string[]])
      : null

  const voteSchema = targetEnum
    ? z.object({
        target: targetEnum.describe('投票指向的候选 ID'),
        vote: z.enum(VOTE_VALUES),
        reason: z.string().min(1).describe('为什么同意/不同意（必填）'),
        suggested_change: z.string().optional().describe('需要修改时怎么改'),
      })
    : null

  const quickSchema = z.object({
    vote: z.enum(VOTE_VALUES).describe('对 M1 的评价'),
    reason: z.string().min(1).describe('为什么同意/不同意（必填）'),
    suggested_change: z.string().optional().describe('需要修改时怎么改'),
  })

  const fullSchema = z.object({
    ...(spec.requireProtocolMode
      ? {
          protocol_mode: (spec.forcedProtocolMode
            ? z.literal(spec.forcedProtocolMode)
            : z.enum(PROTOCOL_MODES)
          ).describe('本任务协议模式：简单任务 main_only / 中等 quick_review / 高风险 full_consensus'),
        }
      : {}),
    candidate: z.object({
      summary: z
        .string()
        .min(1)
        .describe('任务结论的一句话实质摘要；禁止复述用户要求、Agent 数量或协商模式'),
      final_answer_or_plan: z
        .string()
        .min(1)
        .describe('对任务本身的完整分析、事实依据与可执行处理方向；禁止只描述协商流程'),
      evidence_refs: z.array(z.string()).optional().describe('关键证据：文件路径/测试结果/日志摘要'),
      scratch_artifacts: z.array(z.string()).optional().describe('临时实验产物路径（结论依赖实验时必填）'),
      known_risks: z.array(z.string()).optional(),
    }),
    ...(voteSchema
      ? { votes: z.array(voteSchema).describe(`对其他候选的投票，必须覆盖：${spec.mustVote.join('、')}`) }
      : {}),
  })

  let submitted = false

  return buildTool({
    name: PROTOCOL_OUTPUT_TOOL_NAME,
    description: '提交本轮协商的正式结论',
    prompt:
      spec.kind === 'quick'
        ? '提交你对 M1 的快速评价（协商正式输出）。整个回合只能调用一次，调用前先完成必要探索。'
        : '提交你本轮的候选方案与投票（协商正式输出）。整个回合只能调用一次，调用前先完成必要探索。',
    inputSchema: (spec.kind === 'quick' ? quickSchema : fullSchema) as z.ZodObject,
    // 提交会改变本协议回合的内部状态，必须与其它控制工具串行。
    isReadOnly: false,
    kind: 'control',
    endsTurnOnSuccess: true,
    async execute(input) {
      if (submitted) {
        return { data: '协议输出已提交过，本轮不能重复提交。', isError: true }
      }
      const output =
        spec.kind === 'quick'
          ? quickToOutput(spec, input as z.infer<typeof quickSchema>)
          : fullToOutput(spec, input as unknown as FullInput)
      if (typeof output === 'string') {
        return { data: `协议校验失败：${output}`, isError: true }
      }
      submitted = true
      onSubmit(output)
      return { data: '协议输出已记录，本轮立即结束。', isError: false }
    },
  })
}

function quickToOutput(
  spec: ProtocolToolSpec,
  input: { vote: VoteValue; reason: string; suggested_change?: string },
): ProtocolOutput | string {
  const err = checkSuggestedChange(input.vote, input.suggested_change)
  if (err) return err
  return {
    agentId: spec.agentId,
    round: spec.round,
    candidate: null,
    votes: [
      {
        from: spec.agentId,
        target: 'M1',
        vote: input.vote,
        reason: input.reason,
        suggestedChange: input.suggested_change,
      },
    ],
  }
}

interface FullInput {
  protocol_mode?: (typeof PROTOCOL_MODES)[number]
  candidate: {
    summary: string
    final_answer_or_plan: string
    evidence_refs?: string[]
    scratch_artifacts?: string[]
    known_risks?: string[]
  }
  votes?: { target: string; vote: VoteValue; reason: string; suggested_change?: string }[]
}

function fullToOutput(spec: ProtocolToolSpec, input: FullInput): ProtocolOutput | string {
  const votes = input.votes ?? []
  // 强制投票覆盖（协议 §8）：每个 mustVote 目标恰好一票
  for (const target of spec.mustVote) {
    const count = votes.filter((v) => v.target === target).length
    if (count !== 1) {
      return `必须对候选 ${target} 投恰好一票（当前 ${count} 票）。需要投票的候选：${spec.mustVote.join('、')}`
    }
  }
  for (const v of votes) {
    const err = checkSuggestedChange(v.vote, v.suggested_change)
    if (err) return `对 ${v.target} 的投票：${err}`
  }
  const mapped: Vote[] = votes.map((v) => ({
    from: spec.agentId,
    target: v.target,
    vote: v.vote,
    reason: v.reason,
    suggestedChange: v.suggested_change,
  }))
  return {
    agentId: spec.agentId,
    round: spec.round,
    candidate: {
      summary: input.candidate.summary,
      finalAnswerOrPlan: input.candidate.final_answer_or_plan,
      evidenceRefs: input.candidate.evidence_refs,
      scratchArtifacts: input.candidate.scratch_artifacts,
      knownRisks: input.candidate.known_risks,
    },
    votes: mapped,
    protocolMode: input.protocol_mode,
  }
}

/** 协议 §7.3：reject / accept_with_minor_edits 必须给出修改方向 */
function checkSuggestedChange(vote: VoteValue, suggestedChange?: string): string | null {
  if (vote !== 'accept' && !suggestedChange?.trim()) {
    return `vote 为 ${vote} 时必须提供 suggested_change（说明该怎么改）`
  }
  return null
}
