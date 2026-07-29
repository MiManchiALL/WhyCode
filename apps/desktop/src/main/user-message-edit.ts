import type { StopReason } from '@whycode/core'
import type { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import type { UserMessageReservation } from './user-message-routing.ts'

export type EditedMessageStartResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * 与普通输入共用 routing reservation：准备期间不允许另一条消息改变活动父链；
 * 启动器会同步把 Agent 标为 busy，随后即可释放闸门而不等待完整模型回合。
 */
export async function startEditedUserMessage(
  runtime: DesktopSessionRuntime,
  reservation: UserMessageReservation,
  turnId: string,
  text: string,
  onDeliveryError: (error: unknown) => void,
): Promise<EditedMessageStartResult> {
  let released = false
  try {
    await reservation.ready
    if (runtime.executionBusy) {
      return { ok: false, error: 'Agent 尚未空闲，不能编辑已中止消息' }
    }
    if (runtime.consensusEnabled || runtime.coordinator) {
      return { ok: false, error: '协商模式中的消息不能使用单回合编辑' }
    }
    const session = runtime.session
    if (!session) return { ok: false, error: '当前没有可编辑的会话' }

    // Core 的可见历史校验必须看到停止收尾前已经排队的稳定 ViewEvent。
    await runtime.timeline.flush()
    const start = await session.prepareAbortedTurnEdit(turnId, text)
    runtime.beginWork()
    let running: Promise<StopReason>
    try {
      running = start()
    } catch (error) {
      // 编辑事实已经写稳且实时投影已经发出；和普通根输入一样，此后只能报告
      // Agent 交付异常，不能向 Renderer 伪报“编辑未发生”并诱导重复提交。
      reportDeliveryError(runtime, onDeliveryError, error)
      reservation.release()
      released = true
      return { ok: true }
    }
    reservation.release()
    released = true
    void running.catch((error) => reportDeliveryError(runtime, onDeliveryError, error))
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (!released) reservation.release()
  }
}

function reportDeliveryError(
  runtime: DesktopSessionRuntime,
  report: (error: unknown) => void,
  error: unknown,
): void {
  try {
    report(error)
  } catch {}
  // 自定义宿主回调未发送 error 终态时仍保证计时收尾；正式桌面回调已通过
  // agent-status:error 结束，这里幂等执行。
  runtime.finishWork()
}
