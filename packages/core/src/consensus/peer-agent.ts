import { AgentSession, type ApprovalHandler } from '../agent/session.ts'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry, ProviderConfig } from '../providers/registry.ts'
import { createProtocolOutputTool, type ProtocolToolSpec } from './protocol-tool.ts'
import type { ConsensusAgentId, ProtocolOutput } from './types.ts'

/** 停止时未提交协议输出的提醒次数上限（协议 §14.1：连续两次失败标记 invalid） */
const MAX_SUBMIT_REMINDERS = 2

export interface PeerAgentOptions {
  agentId: ConsensusAgentId
  model: ModelEntry
  providerConfig: ProviderConfig
  projectDir: string
  scratchDir: string
  osPlatform: NodeJS.Platform
  /** 事件出口；Orchestrator 负责按 agentId 包装区分 */
  emit: (event: CoreEvent) => void
  requestApproval: ApprovalHandler
}

export type RoundResult =
  | { ok: true; output: ProtocolOutput }
  | { ok: false; error: string }

/**
 * 协商讨论 Agent（M3-a）：一个受限 AgentSession 的生命周期包装。
 * 任务内跨轮保留完整会话（§10 定案）；每轮换入该轮的协议输出工具；
 * 回合结束未提交则注入提醒重试，超限判 invalid。任务结束整个实例丢弃。
 */
export class PeerAgent {
  private session: AgentSession
  readonly agentId: ConsensusAgentId

  constructor(options: PeerAgentOptions) {
    this.agentId = options.agentId
    this.session = new AgentSession({
      model: options.model,
      providerConfig: options.providerConfig,
      promptContext: {
        projectDir: options.projectDir,
        osPlatform: options.osPlatform,
        discussion: { agentId: options.agentId, scratchDir: options.scratchDir },
      },
      emit: options.emit,
      requestApproval: options.requestApproval,
    })
  }

  /** 跑一轮：输入包 → 探索 → 强制协议输出。返回校验通过的结构化结果 */
  async runRound(roundInput: string, spec: ProtocolToolSpec): Promise<RoundResult> {
    let output: ProtocolOutput | null = null
    this.session.setExtraTools([createProtocolOutputTool(spec, (o) => (output = o))])

    let prompt = roundInput
    for (let attempt = 0; attempt <= MAX_SUBMIT_REMINDERS; attempt++) {
      try {
        await this.session.handleUserMessage(prompt)
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (output) return { ok: true, output }
      prompt =
        '你结束了回合但没有调用 SubmitProtocolOutput 工具——没有它你的结论不会被计入协商。' +
        '请立即调用 SubmitProtocolOutput 提交你的正式输出。'
    }
    return { ok: false, error: `连续 ${MAX_SUBMIT_REMINDERS + 1} 次未提交协议输出，本轮标记 invalid` }
  }

  /** 中止当前探索（用户取消整个协商时） */
  abort(): void {
    this.session.abort()
  }
}
