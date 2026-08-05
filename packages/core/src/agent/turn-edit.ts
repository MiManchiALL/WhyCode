import type { ModelMessage } from 'ai'
import { imageDeliveryModeFromMessage } from '../attachments/messages.ts'
import type { ImageAttachment, ImageDeliveryMode } from '../attachments/types.ts'
import type { PdfAttachment } from '../pdf/types.ts'
import { findPendingTurnAbortedIndex } from '../session/interruption.ts'
import type { ViewEvent } from '../session/view-events.ts'

export interface StoppedTurnEditResources {
  attachments: ImageAttachment[]
  imageDelivery?: ImageDeliveryMode
  pdfAttachments: PdfAttachment[]
}

/**
 * 编辑只适用于“用户停止且模型尚无稳定输出”的最新根回合。模型历史和可见历史
 * 同时校验：前者防止撤销已经提交的工具/回答，后者防止抹掉保留的流式正文。
 */
export function stoppedTurnEditResources(
  messages: readonly ModelMessage[],
  viewEvents: readonly ViewEvent[],
  turnId: string,
  rollbackMessageCount: number,
): StoppedTurnEditResources {
  const markerIndex = findPendingTurnAbortedIndex([...messages])
  if (
    markerIndex === null
    || markerIndex < rollbackMessageCount
    || !modelMessageText(messages[markerIndex]!).includes('reason="user-cancel"')
  ) {
    throw new Error('目标回合不是可编辑的用户停止回合')
  }
  if (messages.slice(rollbackMessageCount).some((message) =>
    message.role === 'assistant' || message.role === 'tool')) {
    throw new Error('该回合已有稳定模型输出，不能原位编辑')
  }

  const turnEventIndex = viewEvents.findLastIndex((entry) =>
    entry.type === 'core-event'
    && entry.event.type === 'turn-start'
    && entry.event.turnId === turnId)
  if (turnEventIndex < 0) throw new Error('找不到目标回合的可见起点')
  const hasVisibleOutput = viewEvents.slice(turnEventIndex + 1).some((entry) =>
    entry.type !== 'core-event' || entry.event.type !== 'work-finished')
  if (hasVisibleOutput) throw new Error('该回合已有可见输出，不能原位编辑')

  const rootInput = viewEvents
    .slice(0, turnEventIndex)
    .findLast((entry) => entry.type === 'user-message' && entry.startsTurn)
  if (!rootInput || rootInput.type !== 'user-message') {
    throw new Error('找不到目标回合的根用户消息')
  }
  const attachments = (rootInput.attachments ?? []).map((item) => structuredClone(item))
  const sourceMessage = messages.slice(rollbackMessageCount, markerIndex)
    .find((message) => message.role === 'user')
  const imageDelivery = attachments.length && sourceMessage
    ? imageDeliveryModeFromMessage(sourceMessage)
    : null
  if (attachments.length && !imageDelivery) {
    throw new Error('目标回合缺少图片交付方式')
  }
  return {
    attachments,
    ...(imageDelivery ? { imageDelivery } : {}),
    pdfAttachments: (rootInput.pdfAttachments ?? []).map((item) => structuredClone(item)),
  }
}

function modelMessageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
}
