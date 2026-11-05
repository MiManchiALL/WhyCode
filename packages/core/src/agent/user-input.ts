import { randomUUID } from 'node:crypto'
import type { ModelMessage } from 'ai'
import { createImageUserMessage } from '../attachments/messages.ts'
import type { ImageAttachment, ImageDeliveryMode } from '../attachments/types.ts'
import type { QueuedUserMessage } from '../events.ts'
import { withPdfAttachmentReferences } from '../pdf/messages.ts'
import type { PdfAttachment } from '../pdf/types.ts'
import { activatedSkillSchema, skillSummary, type ActivatedSkill } from '../skills/types.ts'

export interface QueuedMessage {
  id: string
  text: string
  attachments: ImageAttachment[]
  imageDelivery: ImageDeliveryMode
  pdfAttachments: PdfAttachment[]
  skills: ActivatedSkill[]
  persisted: boolean
  urgent?: boolean
}

/** Main 与协调器移交同一条输入，内存会话也保留最初的队列 ID。 */
export function createUserInput(
  text: string,
  attachments: readonly ImageAttachment[],
  persistedInputId: string | undefined,
  pdfAttachments: readonly PdfAttachment[],
  skills: readonly ActivatedSkill[],
  imageDelivery: ImageDeliveryMode = 'native',
): QueuedMessage {
  return {
    id: persistedInputId ?? randomUUID(),
    text,
    persisted: persistedInputId !== undefined,
    attachments: [...attachments],
    imageDelivery,
    pdfAttachments: [...pdfAttachments],
    skills: skills.map(skill => activatedSkillSchema.parse(skill)),
  }
}

export function queuedMessageForModel(message: QueuedMessage): ModelMessage {
  const text = withPdfAttachmentReferences(message.text, message.pdfAttachments)
  return message.attachments.length
    ? createImageUserMessage(text, message.attachments, message.imageDelivery)
    : { role: 'user', content: text }
}

export function queuedUserMessage(message: QueuedMessage): QueuedUserMessage {
  return {
    id: message.id,
    text: message.text,
    ...(message.attachments.length ? { attachments: message.attachments } : {}),
    ...(message.pdfAttachments.length ? { pdfAttachments: message.pdfAttachments } : {}),
    ...(message.skills.length ? { skills: message.skills.map(skillSummary) } : {}),
  }
}
