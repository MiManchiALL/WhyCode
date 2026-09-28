import { checkToolAuthorization, checkToolPermission } from '../permissions/engine.ts'
import type {
  ApprovalSuggestion,
  PermissionContext,
} from '../permissions/types.ts'
import type { ToolContext, ToolDefinition } from '../tools/tool.ts'

export interface ApprovalRequestItem {
  toolCallId: string
  toolName: string
  input: unknown
  reason: string
  diff?: string
}

export interface ApprovalRequest {
  requestId: string
  toolName: string
  input: unknown
  /** 为什么需要审批（权限引擎给出） */
  reason: string
  diff?: string
  /** 同一模型步骤内需要共同确认的精确工具调用；单项审批省略。 */
  items?: readonly ApprovalRequestItem[]
  /** 批准时可勾选的「记住」建议（add-dir / allow-tool），无建议则只能单次批准 */
  suggestion?: ApprovalSuggestion
}

export interface ApprovalResponse {
  approved: boolean
  /** true = 采纳 suggestion（本会话记住） */
  remember?: boolean
}

/** 宿主必须在 signal 中止时关闭该请求并返回拒绝，不保留迟到批准。 */
export type ApprovalHandler = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalResponse>

export type ToolAuthorization =
  | { approved: true; approvedPaths: string[] }
  | { approved: false; message: string }

interface QueuedToolApproval {
  def: ToolDefinition
  input: Record<string, unknown>
  toolCtx: ToolContext
  toolCallId: string
  resolve: (authorization: ToolAuthorization) => void
  reject: (error: unknown) => void
}

interface PendingToolApproval extends QueuedToolApproval {
  decision: Extract<Awaited<ReturnType<typeof checkToolAuthorization>>, { behavior: 'ask' }>
}

interface StepToolApprovalBatcherOptions {
  permissions: () => PermissionContext
  setStatus: (status: 'waiting-approval' | 'working') => void
  requestApproval: ApprovalHandler
  applySuggestion: (suggestion: ApprovalSuggestion) => void
}

/**
 * 同一模型响应中的工具共同进入审批。协调器先完成每项独立判定，
 * 再把同一事件循环批次中的 ask 合成一张精确清单；批准不会扩张到未展示的调用。
 */
export class StepToolApprovalBatcher {
  private pending: QueuedToolApproval[] = []
  private scheduled = false
  private draining = false
  private readonly options: StepToolApprovalBatcherOptions

  constructor(options: StepToolApprovalBatcherOptions) {
    this.options = options
  }

  authorize(
    def: ToolDefinition,
    input: Record<string, unknown>,
    toolCtx: ToolContext,
    toolCallId: string,
  ): Promise<ToolAuthorization> {
    if (toolCtx.abortSignal.aborted) return Promise.resolve(cancelledAuthorization())
    return new Promise<ToolAuthorization>((resolve, reject) => {
      this.pending.push({ def, input, toolCtx, toolCallId, resolve, reject })
      this.scheduleDrain()
    })
  }

  private scheduleDrain(): void {
    if (this.scheduled || this.draining) return
    this.scheduled = true
    // 工具参数校验可能跨多个微任务；下一事件循环仍属于同一 model-call-end 批次。
    setTimeout(() => {
      this.scheduled = false
      void this.drain()
    }, 0)
  }

  private async drain(): Promise<void> {
    if (this.draining || this.pending.length === 0) return
    this.draining = true
    const queued = this.pending.splice(0)
    try {
      const batch = await this.refreshPending(queued)
      if (batch.length > 0) {
        const suggestion = sharedApprovalSuggestion(batch)
        const response = await this.requestBatch(batch, suggestion)
        if (response.approved && response.remember && suggestion
          && !batch[0]!.toolCtx.abortSignal.aborted) {
          this.options.applySuggestion(suggestion)
        }
        await this.settleBatch(batch, response)
      }
    } catch (error) {
      for (const pending of queued) pending.reject(error)
    } finally {
      this.draining = false
      if (this.pending.length > 0) this.scheduleDrain()
    }
  }

  private async refreshPending(queued: QueuedToolApproval[]): Promise<PendingToolApproval[]> {
    return (await Promise.all(queued.map(async (pending) => {
      if (pending.toolCtx.abortSignal.aborted) {
        pending.resolve(cancelledAuthorization())
        return []
      }
      const latest = await checkToolAuthorization(
        pending.def,
        pending.input,
        this.options.permissions(),
      )
      if (pending.toolCtx.abortSignal.aborted) {
        pending.resolve(cancelledAuthorization())
        return []
      }
      if (latest.behavior === 'deny') {
        pending.resolve(deniedAuthorization(latest.reason))
        return []
      }
      if (latest.behavior === 'allow') {
        pending.resolve(allowedAuthorization(pending.def, pending.input))
        return []
      }
      return [{ ...pending, decision: latest }]
    }))).flat()
  }

  private async requestBatch(
    batch: readonly PendingToolApproval[],
    suggestion: ApprovalSuggestion | undefined,
  ): Promise<ApprovalResponse> {
    const signal = batch[0]!.toolCtx.abortSignal
    const request = await buildApprovalRequest(batch, suggestion)
    if (signal.aborted) return { approved: false }
    this.options.setStatus('waiting-approval')
    try {
      return await this.options.requestApproval(request, signal)
    } finally {
      this.options.setStatus('working')
    }
  }

  private async settleBatch(
    batch: readonly PendingToolApproval[],
    response: ApprovalResponse,
  ): Promise<void> {
    for (const pending of batch) {
      if (pending.toolCtx.abortSignal.aborted) {
        pending.resolve(cancelledAuthorization())
        continue
      }
      const latest = await checkToolPermission(pending.def, pending.input, this.options.permissions())
      if (pending.toolCtx.abortSignal.aborted) {
        pending.resolve(cancelledAuthorization())
      } else if (latest.behavior === 'deny') {
        pending.resolve(deniedAuthorization(latest.reason))
      } else if (!response.approved) {
        pending.resolve({
          approved: false,
          message: `用户拒绝了此操作（${pending.decision.reason}）`,
        })
      } else {
        pending.resolve(allowedAuthorization(pending.def, pending.input))
      }
    }
  }
}

async function buildApprovalRequest(
  batch: readonly PendingToolApproval[],
  suggestion: ApprovalSuggestion | undefined,
): Promise<ApprovalRequest> {
  const items = await Promise.all(batch.map(async (pending): Promise<ApprovalRequestItem> => {
    const diff = await pending.def.renderDiff?.(pending.input, pending.toolCtx)
      .catch(() => undefined)
    return {
      toolCallId: pending.toolCallId,
      toolName: pending.def.name,
      input: pending.input,
      reason: pending.decision.reason,
      ...(diff ? { diff } : {}),
    }
  }))
  if (batch.length === 1) {
    const pending = batch[0]!
    return {
      requestId: pending.toolCallId,
      toolName: pending.def.name,
      input: pending.input,
      reason: pending.decision.reason,
      ...(items[0]!.diff ? { diff: items[0]!.diff } : {}),
      ...(suggestion ? { suggestion } : {}),
    }
  }
  return {
    requestId: batch[0]!.toolCallId,
    toolName: `批量工具操作（${batch.length} 项）`,
    input: items.map(({ toolName, input }) => ({ toolName, input })),
    reason: '同一模型步骤请求执行以下操作；批准将仅覆盖下列精确输入。',
    items,
    ...(suggestion ? { suggestion } : {}),
  }
}

function sharedApprovalSuggestion(
  batch: readonly PendingToolApproval[],
): ApprovalSuggestion | undefined {
  const first = batch[0]?.decision.suggestion
  if (!first) return undefined
  const serialized = JSON.stringify(first)
  return batch.every((pending) => JSON.stringify(pending.decision.suggestion) === serialized)
    ? first
    : undefined
}

function allowedAuthorization(
  def: ToolDefinition,
  input: Record<string, unknown>,
): ToolAuthorization {
  return { approved: true, approvedPaths: def.extractPaths?.(input) ?? [] }
}

function deniedAuthorization(reason: string): ToolAuthorization {
  return { approved: false, message: `操作被拒绝：${reason}` }
}

function cancelledAuthorization(): ToolAuthorization {
  return { approved: false, message: '操作已取消' }
}
