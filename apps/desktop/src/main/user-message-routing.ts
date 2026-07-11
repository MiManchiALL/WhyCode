export interface UserMessageRoute {
  isBusy: () => boolean
  record: (text: string, startsTurn: boolean) => Promise<void>
  acceptRoot: (text: string) => void
  deliver: (text: string, urgent: boolean) => Promise<unknown> | void
}

/**
 * 用户输入的权威分类必须在同一个同步临界段完成：判 busy、启动落盘、显示根消息、
 * 再交给运行时。四步之间不得 await，否则快速 A/B 可能都被误判为新 turn。
 */
export async function routeUserMessage(
  text: string,
  urgent: boolean,
  route: UserMessageRoute,
): Promise<boolean> {
  const startsTurn = !route.isBusy()
  const recording = route.record(text, startsTurn)
  if (startsTurn) route.acceptRoot(text)
  const handling = route.deliver(text, urgent)
  await recording
  await handling
  return startsTurn
}
