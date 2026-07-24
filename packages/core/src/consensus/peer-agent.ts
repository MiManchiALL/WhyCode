import { AgentSession, type ApprovalHandler } from '../agent/session.ts'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry, ProviderConfig } from '../providers/registry.ts'
import { runProtocolRound, type RoundResult } from './run-round.ts'
import type { ProtocolToolSpec } from './protocol-tool.ts'
import type { ConsensusAgentId } from './types.ts'

export interface PeerAgentOptions {
  agentId: ConsensusAgentId
  model: ModelEntry
  providerConfig: ProviderConfig
  projectDir: string | null
  scratchDir: string
  osPlatform: NodeJS.Platform
  homeDir?: string
  /** 事件出口；Orchestrator 负责按 agentId 包装区分 */
  emit: (event: CoreEvent) => void
  requestApproval: ApprovalHandler
}

/**
 * 协商讨论 Agent（M3-a）：一个受限 AgentSession 的生命周期包装。
 * 任务内跨轮保留完整会话（§10 定案）；任务结束整个实例丢弃。
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
        homeDir: options.homeDir,
        discussion: { agentId: options.agentId, scratchDir: options.scratchDir },
      },
      emit: options.emit,
      requestApproval: options.requestApproval,
    })
  }

  /** 跑一轮：输入包 → 探索 → 强制协议输出。返回校验通过的结构化结果 */
  runRound(roundInput: string, spec: ProtocolToolSpec): Promise<RoundResult> {
    return runProtocolRound(this.session, roundInput, spec)
  }

  /** 自由探索回合（独立初判用，协议 §9）：无协议工具，产出留在自身上下文 */
  async explore(input: string): Promise<void> {
    this.session.setExtraTools([])
    await this.session.handleUserMessage(input)
  }

  /** 中止当前探索（用户取消整个协商时） */
  abort(): void {
    this.session.abort()
  }
}
