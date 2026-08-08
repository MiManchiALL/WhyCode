import type { PreparedLatestTurnEdit } from '@whycode/core'
import type { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import type { UserMessageReservation } from './user-message-routing.ts'

export type EditedMessageStartResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * 编辑后的输入已经是新的持久根。直接模式复用 Core 准备好的 Main 启动器；
 * 协商模式必须把同一个 inputId 交给协调器，不能再创建第二条根输入。
 */
export function deliverEditedUserMessage(
  runtime: DesktopSessionRuntime,
  prepared: PreparedLatestTurnEdit,
): Promise<unknown> | void {
  runtime.coordinator?.resetPersistedState(runtime.journal?.initialConsensusState ?? null)
  if (!runtime.consensusEnabled) return prepared.startMain()

  const coordinator = runtime.coordinator
  if (!coordinator) throw new Error('协商协调器尚未初始化')
  prepared.accept()
  return coordinator.handleUserMessage(
    prepared.text,
    false,
    prepared.attachments,
    prepared.inputId,
    prepared.pdfAttachments,
    prepared.skills,
    prepared.imageDelivery,
  )
}

/**
 * 与普通输入共用 routing reservation：准备期间不允许另一条消息改变活动父链；
 * 启动器会同步把 Agent 标为 busy，随后即可释放闸门而不等待完整模型回合。
 */
export async function startEditedUserMessage(
  runtime: DesktopSessionRuntime,
  reservation: UserMessageReservation,
  turnId: string,
  text: string,
  deliver: (prepared: PreparedLatestTurnEdit) => Promise<unknown> | void,
  onDeliveryError: (error: unknown) => void,
): Promise<EditedMessageStartResult> {
  let released = false
  try {
    await reservation.ready
    if (runtime.executionBusy) {
      return { ok: false, error: 'Agent 尚未空闲，不能编辑最新消息' }
    }
    const session = runtime.session
    if (!session) return { ok: false, error: '当前没有可编辑的会话' }

    // Core 的最新消息校验必须看到此前已经排队的全部稳定 ViewEvent。
    await runtime.timeline.flush()
    const prepared = await session.prepareLatestTurnEdit(turnId, text)
    runtime.beginWork()
    let running: Promise<unknown>
    try {
      running = Promise.resolve(deliver(prepared))
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
