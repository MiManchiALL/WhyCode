import {
  IMAGE_ATTACHMENT_MAX_COUNT,
  PDF_ATTACHMENT_MAX_COUNT,
  PDF_ATTACHMENT_MAX_TOTAL_BYTES,
  prepareImageAttachmentImport,
  preparePdfAttachmentImport,
  type CoreCommand,
  type ImageAttachment,
  type ImageAttachmentInput,
  type PdfAttachment,
  type PdfAttachmentInput,
  type PdfProcessor,
  type SessionJournal,
} from '@whycode/core'

type UserMessageCommand = Extract<CoreCommand, { type: 'user-message' }>

export interface PreparedUserMessageAttachments {
  attachments: ImageAttachment[]
  pdfAttachments: PdfAttachment[]
  restoredInputIds: string[]
  importedFiles: boolean
}

/** 纯文本必须绕过附件锁，保留既有的快速 A/B 输入 FIFO 语义。 */
export function userMessageNeedsAttachmentPreparation(command: UserMessageCommand): boolean {
  return Boolean(
    command.attachments?.length
    || command.pdfAttachments?.length
    || command.restoredInputIds?.length,
  )
}

export async function prepareUserMessageAttachments(options: {
  command: UserMessageCommand
  journal: SessionJournal
  pdfProcessor: PdfProcessor
  supportsImageInput: boolean
  modelDisplayName: string
  abortSignal: AbortSignal
}): Promise<PreparedUserMessageAttachments> {
  const { command, journal } = options
  const imageInputs = command.attachments ?? []
  const pdfInputs = command.pdfAttachments ?? []
  const newImages = freshImages(imageInputs)
  const newPdfs = freshPdfs(pdfInputs)
  const restoredInputIds = command.restoredInputIds ?? []
  if (imageInputs.length > 0 && !options.supportsImageInput) {
    throw new Error(`${options.modelDisplayName} 不支持识图；请切换到带“图片”标记的模型`)
  }

  const imageImport = await prepareImageAttachmentImport(
    newImages,
    journal.attachmentDirectory,
    journal.sessionId,
    options.abortSignal,
  )
  let pdfImport: Awaited<ReturnType<typeof preparePdfAttachmentImport>> | null = null
  try {
    pdfImport = await preparePdfAttachmentImport(
      newPdfs,
      journal.attachmentDirectory,
      journal.sessionId,
      options.pdfProcessor,
      options.abortSignal,
    )
    const restored = restoredInputs(journal, restoredInputIds)
    const attachments = [
      ...resolveRestoredImages(restored, storedIds(imageInputs)),
      ...imageImport.attachments,
    ]
    const pdfAttachments = [
      ...resolveRestoredPdfs(restored, storedIds(pdfInputs)),
      ...pdfImport.attachments,
    ]
    validatePreparedAttachments(attachments, pdfAttachments)
    await imageImport.commit()
    await pdfImport.commit()
    return {
      attachments,
      pdfAttachments,
      restoredInputIds,
      importedFiles: newImages.length > 0 || newPdfs.length > 0,
    }
  } catch (error) {
    await Promise.all([
      imageImport.rollback().catch(() => {}),
      pdfImport?.rollback().catch(() => {}),
    ])
    throw error
  }
}

function restoredInputs(
  journal: SessionJournal,
  restoredInputIds: readonly string[],
): SessionJournal['pendingUserInputs'] {
  if (new Set(restoredInputIds).size !== restoredInputIds.length) {
    throw new Error('恢复输入 ID 不能重复')
  }
  const restoredById = new Map(
    journal.pendingUserInputs
      .filter((input) => input.state === 'restored')
      .map((input) => [input.id, input]),
  )
  return restoredInputIds.map((inputId) => {
    const input = restoredById.get(inputId)
    if (!input) throw new Error(`恢复输入已失效或不属于当前会话：${inputId}`)
    return input
  })
}

function resolveRestoredImages(
  inputs: SessionJournal['pendingUserInputs'],
  attachmentIds: readonly string[],
): ImageAttachment[] {
  return resolveRestored(
    inputs.flatMap((input) => input.attachments ?? []),
    attachmentIds,
    '图片',
  )
}

function resolveRestoredPdfs(
  inputs: SessionJournal['pendingUserInputs'],
  attachmentIds: readonly string[],
): PdfAttachment[] {
  return resolveRestored(
    inputs.flatMap((input) => input.pdfAttachments ?? []),
    attachmentIds,
    'PDF',
  )
}

function resolveRestored<T extends { id: string }>(
  allowed: readonly T[],
  attachmentIds: readonly string[],
  label: string,
): T[] {
  if (new Set(attachmentIds).size !== attachmentIds.length) {
    throw new Error(`恢复${label}不能重复添加`)
  }
  const byId = new Map(allowed.map((attachment) => [attachment.id, attachment]))
  return attachmentIds.map((attachmentId) => {
    const attachment = byId.get(attachmentId)
    if (!attachment) throw new Error(`恢复${label}已失效或不属于所选输入：${attachmentId}`)
    return attachment
  })
}

function validatePreparedAttachments(
  attachments: readonly ImageAttachment[],
  pdfAttachments: readonly PdfAttachment[],
): void {
  if (attachments.length > IMAGE_ATTACHMENT_MAX_COUNT) {
    throw new Error(`每条消息最多添加 ${IMAGE_ATTACHMENT_MAX_COUNT} 张图片`)
  }
  const imageIdentities = attachments.map((attachment) =>
    attachment.sha256 ?? attachment.storageName)
  if (new Set(imageIdentities).size !== imageIdentities.length) {
    throw new Error('同一张图片不能重复添加')
  }
  if (pdfAttachments.length > PDF_ATTACHMENT_MAX_COUNT) {
    throw new Error(`每条消息最多添加 ${PDF_ATTACHMENT_MAX_COUNT} 个 PDF`)
  }
  if (new Set(pdfAttachments.map((attachment) => attachment.sha256)).size !== pdfAttachments.length) {
    throw new Error('同一个 PDF 不能重复添加')
  }
  const pdfBytes = pdfAttachments.reduce((total, attachment) => total + attachment.byteLength, 0)
  if (pdfBytes > PDF_ATTACHMENT_MAX_TOTAL_BYTES) {
    throw new Error('PDF 附件总大小超过 100 MB 上限')
  }
}

function freshImages(inputs: readonly NonNullable<UserMessageCommand['attachments']>[number][]) {
  return inputs.filter((input): input is ImageAttachmentInput => input.kind !== 'stored')
}

function freshPdfs(inputs: readonly NonNullable<UserMessageCommand['pdfAttachments']>[number][]) {
  return inputs.filter((input): input is PdfAttachmentInput => input.kind !== 'stored')
}

function storedIds<T extends { kind: string }>(inputs: readonly T[]): string[] {
  return inputs.flatMap((input) => input.kind === 'stored' && 'attachmentId' in input
    ? [String(input.attachmentId)]
    : [])
}
