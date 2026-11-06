import { skillSummary, type CoreCommand } from '@whycode/core'
import type { RuntimeCommandResult } from '../shared/session.ts'
import type { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import type { UserMessageReservation } from './user-message-routing.ts'

interface QueuedMessageActionHost {
  reserveWorkStart(): UserMessageReservation | null
  prepareExecution(): Promise<void>
  onDeliveryError(error: unknown): void
}

/** 编辑和丢弃不初始化模型；立即发送复用根输入的容量、连接与串行交付边界。 */
export async function handleQueuedMessageAction(
  runtime: DesktopSessionRuntime,
  command: Extract<CoreCommand, { type: 'queued-message-action' }>,
  host: QueuedMessageActionHost,
): Promise<RuntimeCommandResult> {
  const reservation = command.action === 'send-now'
    ? host.reserveWorkStart()
    : runtime.routingGate.reserve()
  if (!reservation) return { ok: false, error: '同时运行的对话已达到上限，请等待其中一个结束' }
  try {
    await reservation.ready
    const input = runtime.journal?.pendingUserInputs.find(item => item.id === command.id && item.state === 'queued')
    if (!input) return command.action === 'edit'
      ? { ok: false, error: '这条消息已离开队列' }
      : { ok: true, workspace: runtime.workspace }

    if (command.action === 'send-now') await host.prepareExecution()
    const target = runtime.coordinator ?? runtime.session
    if (!target) {
      // 未连接的远端或未配置模型的冷恢复会话，仍可管理已经写稳的队列。
      const journal = runtime.journal!
      if (command.action === 'edit') {
        await journal.markUserInputsRestored([input.id], command.replacesRestoredInputIds)
        runtime.emit({ type: 'queued-message-edit-ready', item: {
          id: input.id, text: input.text,
          attachments: input.attachments, pdfAttachments: input.pdfAttachments,
          skills: input.skills?.map(skillSummary),
        } })
      } else if (command.action === 'discard') {
        await journal.markUserInputsDiscarded([input.id])
        runtime.emit({ type: 'message-dequeued', id: input.id })
      } else {
        return { ok: false, error: '当前会话尚未就绪，无法发送排队消息' }
      }
      return { ok: true, workspace: runtime.workspace }
    }

    const handled = command.action === 'edit'
      ? await target.restoreQueuedMessage(command.id, command.replacesRestoredInputIds)
      : command.action === 'discard'
        ? await target.discardQueuedMessage(command.id)
        : target.sendQueuedMessageNow(command.id)
    if (handled instanceof Promise) {
      // 只确认接收，不占着 IPC/输入闸门等待完整模型回合。
      void handled.catch(host.onDeliveryError)
    }
    if (handled) return { ok: true, workspace: runtime.workspace }

    const stillQueued = runtime.journal?.pendingUserInputs.some(item => item.id === command.id && item.state === 'queued')
    if (!stillQueued && command.action !== 'edit') return { ok: true, workspace: runtime.workspace }
    return { ok: false, error: stillQueued ? '排队消息状态已经变化，请重试' : '这条消息已离开队列' }
  } catch (error) {
    return { ok: false, error: `排队消息操作失败：${error instanceof Error ? error.message : String(error)}` }
  } finally {
    reservation.release()
    if (!runtime.busy) runtime.emit({ type: 'agent-status', status: 'idle' }, false)
  }
}
