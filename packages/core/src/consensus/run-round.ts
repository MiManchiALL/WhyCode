import type { AgentSession } from '../agent/session.ts'
import { createProtocolOutputTool, type ProtocolToolSpec } from './protocol-tool.ts'
import type { ProtocolOutput } from './types.ts'

/** 停止时未提交协议输出的提醒次数上限（协议 §14.1：连续两次失败标记 invalid） */
const MAX_SUBMIT_REMINDERS = 2

export type RoundResult =
  | { ok: true; output: ProtocolOutput }
  | { ok: false; error: string }

/**
 * 在指定会话上跑一轮协议输出（Main 的 M1/M2/M3 与 B/C 各轮共用）：
 * 换入该轮的协议工具 → 探索 → 回合结束未提交则注入提醒重试，超限判 invalid。
 */
export async function runProtocolRound(
  session: AgentSession,
  roundInput: string,
  spec: ProtocolToolSpec,
): Promise<RoundResult> {
  let output: ProtocolOutput | null = null
  session.setExtraTools([createProtocolOutputTool(spec, (o) => (output = o))])

  let prompt = roundInput
  for (let attempt = 0; attempt <= MAX_SUBMIT_REMINDERS; attempt++) {
    try {
      await session.handleUserMessage(prompt)
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
