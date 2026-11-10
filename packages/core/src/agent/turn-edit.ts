import type { QuestionReply } from '../user-questions.ts'
import { userTurn, type ConversationMessage } from '../context/user-turn.ts'
import type { ModelMessage } from 'ai'
import { imageDeliveryModeFromMessage } from '../attachments/messages.ts'
import type { ImageAttachment, ImageDeliveryMode } from '../attachments/types.ts'
import type { PdfAttachment } from '../pdf/types.ts'
import { latestVisibleRootTurn, type ViewEvent } from '../session/view-events.ts'
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
  if (recorder.interruptedTurnId) throw new Error('仍有活动回合，不能编辑最新消息')
  if (recorder.undeliveredUserInputIds.length > 0) {
    throw new Error('新提交的根消息尚未交付，不能编辑最新消息')
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
  questionReply?: QuestionReply
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
  const { root: rootInput, afterRoot } = latestVisibleRootTurn(viewEvents, turnId)
  const attachments = (rootInput.attachments ?? []).map((item) => structuredClone(item))
  const suffix: ConversationMessage[] = messages.slice(rollbackMessageCount)
  const sourceMessage = suffix.find(message => message.role === 'user')
  const imageDelivery = attachments.length && sourceMessage
    ? imageDeliveryModeFromMessage(sourceMessage)
    : null
  if (attachments.length && !imageDelivery) {
    throw new Error('目标回合缺少图片交付方式')
  }
  const rootMessage = suffix.find(item => userTurn(item)?.startsTurn)
  const replies = new Map(rootMessage?.whycode?.questionReply?.map(item => [item.id, item]))
  for (const message of suffix) {
    for (const id of message.whycode?.skippedQuestionIds ?? []) {
      if (!replies.has(id)) replies.set(id, { id, answer: null })
    }
  }
  return {
    ...(replies.size ? { questionReply: [...replies.values()] } : {}),
    turnIds: afterRoot.flatMap((entry) => entry.type === 'core-event'
      && entry.event.type === 'turn-start' ? [entry.event.turnId] : []),
    attachments,
    ...(imageDelivery ? { imageDelivery } : {}),
    pdfAttachments: (rootInput.pdfAttachments ?? []).map((item) => structuredClone(item)),
  }
}
