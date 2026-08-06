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

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalResponse>

export type ToolAuthorization =
  | { approved: true; approvedPaths: string[] }
  | { approved: false; message: string }

interface PendingToolApproval {
  def: ToolDefinition
  input: Record<string, unknown>
  toolCtx: ToolContext
  toolCallId: string
  decision: Extract<ReturnType<typeof checkToolAuthorization>, { behavior: 'ask' }>
  resolve: (authorization: ToolAuthorization) => void
  reject: (error: unknown) => void
}

interface StepToolApprovalBatcherOptions {
  permissions: () => PermissionContext
  setStatus: (status: 'waiting-approval' | 'working') => void
  requestApproval: ApprovalHandler
  applySuggestion: (suggestion: ApprovalSuggestion) => void
}

/**
 * AI SDK 会在 model-call-end 并发启动同一步的全部工具。协调器先完成每项独立判定，
 * 再把同一事件循环批次中的 ask 合成一张精确清单；批准不会扩张到未展示的调用。
 */
export class StepToolApprovalBatcher {
  private pending: PendingToolApproval[] = []
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
    const decision = checkToolAuthorization(def, input, this.options.permissions())
    if (decision.behavior === 'deny') {
      return Promise.resolve(deniedAuthorization(decision.reason))
    }
    if (decision.behavior === 'allow') {
      return Promise.resolve(allowedAuthorization(def, input))
    }
    return new Promise<ToolAuthorization>((resolve, reject) => {
      this.pending.push({ def, input, toolCtx, toolCallId, decision, resolve, reject })
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
    const batch = this.refreshPending(this.pending.splice(0))
    try {
      if (batch.length > 0) {
        const suggestion = sharedApprovalSuggestion(batch)
        const response = await this.requestBatch(batch, suggestion)
        if (response.approved && response.remember && suggestion) {
          this.options.applySuggestion(suggestion)
        }
        this.settleBatch(batch, response)
      }
    } catch (error) {
      for (const pending of batch) pending.reject(error)
    } finally {
      this.draining = false
      if (this.pending.length > 0) this.scheduleDrain()
    }
  }

  private refreshPending(queued: PendingToolApproval[]): PendingToolApproval[] {
    return queued.flatMap((pending) => {
      if (pending.toolCtx.abortSignal.aborted) {
        pending.resolve(cancelledAuthorization())
        return []
      }
      const latest = checkToolAuthorization(
        pending.def,
        pending.input,
        this.options.permissions(),
      )
      if (latest.behavior === 'deny') {
        pending.resolve(deniedAuthorization(latest.reason))
        return []
      }
      if (latest.behavior === 'allow') {
        pending.resolve(allowedAuthorization(pending.def, pending.input))
        return []
      }
      pending.decision = latest
      return [pending]
    })
  }

  private async requestBatch(
    batch: readonly PendingToolApproval[],
    suggestion: ApprovalSuggestion | undefined,
  ): Promise<ApprovalResponse> {
    const request = await buildApprovalRequest(batch, suggestion)
    this.options.setStatus('waiting-approval')
    try {
      return await this.options.requestApproval(request)
    } finally {
      this.options.setStatus('working')
    }
  }

  private settleBatch(
    batch: readonly PendingToolApproval[],
    response: ApprovalResponse,
  ): void {
    for (const pending of batch) {
      if (pending.toolCtx.abortSignal.aborted) {
        pending.resolve(cancelledAuthorization())
        continue
      }
      const latest = checkToolPermission(pending.def, pending.input, this.options.permissions())
      if (latest.behavior === 'deny') {
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
