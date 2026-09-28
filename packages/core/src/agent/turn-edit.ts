import type { ModelMessage } from 'ai'
import { imageDeliveryModeFromMessage } from '../attachments/messages.ts'
import type { ImageAttachment, ImageDeliveryMode } from '../attachments/types.ts'
import type { PdfAttachment } from '../pdf/types.ts'
import type { ViewEvent } from '../session/view-events.ts'
import type { SessionRecorder } from '../session/types.ts'
import { CheckpointManager, type TurnEditEffects } from '../checkpoints/manager.ts'

/** 编辑预览只依赖本机历史和检查点，不初始化模型或连接工作区。 */
export async function inspectLatestTurnEdit(recorder: SessionRecorder, turnId: string): Promise<TurnEditEffects> {
  const { resources } = latestTurnEditContext(recorder, turnId)
  return new CheckpointManager({ sessionId: recorder.sessionId, sessionDir: recorder.checkpointDirectory })
    .turnEditEffects(resources.turnIds)
}

export function latestTurnEditContext(recorder: SessionRecorder, turnId: string, messages = recorder.initialMessages) {
  if (recorder.interruptedConsensusTaskId) throw new Error('协商或评审回合不能使用单回合编辑')
  if (recorder.undeliveredUserInputIds.length > 0 || recorder.pendingUserInputs.length > 0) {
    throw new Error('会话仍有待处理输入，不能编辑最新消息')
  }
  const rollbackMessages = recorder.messagesBeforeTurn(turnId)
  const rollbackTaskState = recorder.taskStateBeforeTurn(turnId)
  const skills = recorder.skillsForTurn(turnId)
  if (rollbackMessages === null || rollbackTaskState === undefined || skills === null) {
    throw new Error('目标回合已不在当前活动历史中')
  }
  const resources = latestTurnEditResources(messages, recorder.initialViewEvents, turnId, rollbackMessages.length)
  return { recorder, rollbackMessages, rollbackTaskState, skills, resources }
}

export interface LatestTurnEditResources {
  turnIds: string[]
  attachments: ImageAttachment[]
  imageDelivery?: ImageDeliveryMode
  pdfAttachments: PdfAttachment[]
}

/**
 * 从最新根回合恢复原消息的附件投递语义。首个 turn 才是根消息在时间线上的
 * 身份；协商内部后续 turn 不会把同一条用户消息误判为更旧或新的根。
 */
export function latestTurnEditResources(
  messages: readonly ModelMessage[],
  viewEvents: readonly ViewEvent[],
  turnId: string,
  rollbackMessageCount: number,
): LatestTurnEditResources {
  const turnEventIndex = viewEvents.findLastIndex((entry) =>
    entry.type === 'core-event'
    && entry.event.type === 'turn-start'
    && entry.event.turnId === turnId)
  if (turnEventIndex < 0) throw new Error('找不到目标回合的可见起点')
  const rootInputIndex = viewEvents
    .slice(0, turnEventIndex)
    .findLastIndex((entry) => entry.type === 'user-message' && entry.startsTurn)
  const rootInput = viewEvents[rootInputIndex]
  if (!rootInput || rootInput.type !== 'user-message') {
    throw new Error('找不到目标回合的根用户消息')
  }
  const afterRoot = viewEvents.slice(rootInputIndex + 1)
  const firstTurn = afterRoot.find((entry) =>
    entry.type === 'core-event' && entry.event.type === 'turn-start')
  if (
    firstTurn?.type !== 'core-event'
    || firstTurn.event.type !== 'turn-start'
    || firstTurn.event.turnId !== turnId
    || afterRoot.some((entry) => entry.type === 'user-message')
  ) {
    throw new Error('只能编辑最新一条用户消息')
  }
  const attachments = (rootInput.attachments ?? []).map((item) => structuredClone(item))
  const sourceMessage = messages.slice(rollbackMessageCount)
    .find((message) => message.role === 'user')
  const imageDelivery = attachments.length && sourceMessage
    ? imageDeliveryModeFromMessage(sourceMessage)
    : null
  if (attachments.length && !imageDelivery) {
    throw new Error('目标回合缺少图片交付方式')
  }
  return {
    turnIds: afterRoot.flatMap((entry) => entry.type === 'core-event'
      && entry.event.type === 'turn-start' ? [entry.event.turnId] : []),
    attachments,
    ...(imageDelivery ? { imageDelivery } : {}),
    pdfAttachments: (rootInput.pdfAttachments ?? []).map((item) => structuredClone(item)),
  }
}
