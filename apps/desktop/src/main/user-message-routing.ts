import { randomUUID } from 'node:crypto'

export interface UserMessageReservation {
  ready: Promise<void>
  release(): void
}

/** 单窗口输入的 FIFO 闸门；只串行到 Agent 同步接收消息，不等待整个模型回合。 */
export class UserMessageRoutingGate {
  private tail: Promise<void> = Promise.resolve()
  private reservationCount = 0

  get busy(): boolean {
    return this.reservationCount > 0
  }

  reserve(): UserMessageReservation {
    const ready = this.tail
    let unlock!: () => void
    const occupied = new Promise<void>((resolve) => { unlock = resolve })
    this.tail = ready.then(() => occupied)
    this.reservationCount++
    let active = true
    return {
      ready,
      release: () => {
        if (!active) return
        active = false
        this.reservationCount--
        unlock()
      },
    }
  }
}

export interface UserMessageRoute {
  isBusy: () => boolean
  /** 在首次 await 前同步占位，避免并发输入同时被判为新根消息。 */
  reserve: () => UserMessageReservation
  record: (inputId: string, text: string, startsTurn: boolean) => Promise<void>
  acceptRoot: (text: string) => void
  deliver: (
    inputId: string,
    text: string,
    urgent: boolean,
    startsTurn: boolean,
  ) => Promise<unknown> | void
  onDeliveryError?: (error: unknown) => void
}

/**
 * 用户输入先在同步临界段完成 busy 分类与占位，再等 JSONL 写稳后交给运行时。
 * 这样快速 A/B 不会同时成为新根消息，持久化失败时模型也绝不会提前看到输入。
 */
export async function routeUserMessage(
  text: string,
  urgent: boolean,
  route: UserMessageRoute,
): Promise<boolean> {
  const startsTurn = !route.isBusy()
  const inputId = randomUUID()
  const reservation = route.reserve()
  let released = false
  try {
    await reservation.ready
    await route.record(inputId, text, startsTurn)
    if (startsTurn) route.acceptRoot(text)
    let handling: Promise<unknown> | void
    try {
      handling = route.deliver(inputId, text, urgent, startsTurn)
    } catch (error) {
      // 输入已经写稳，不能再向 Renderer 报“发送失败”并恢复出一份可重复提交的草稿。
      reservation.release()
      released = true
      reportDeliveryError(route, error)
      return startsTurn
    }
    // deliver 必须在返回前同步把 Agent 标成 busy；之后占位即可释放。
    reservation.release()
    released = true
    // IPC 只确认“已持久化并交给 Agent”，不等待整个模型回合结束。
    // 异步执行异常由事件流上报，避免首条图片在工作全程锁住后续补图。
    void Promise.resolve(handling).catch((error) => reportDeliveryError(route, error))
    return startsTurn
  } finally {
    if (!released) reservation.release()
  }
}

function reportDeliveryError(route: UserMessageRoute, error: unknown): void {
  // 错误通知本身不能改变已经提交的输入结果，也不能制造未处理的 Promise rejection。
  try {
    route.onDeliveryError?.(error)
  } catch {}
}
