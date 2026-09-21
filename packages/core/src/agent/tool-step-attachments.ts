import type { ModelMessage } from 'ai'
import { attachImagesToToolResults } from '../attachments/tool-results.ts'
import { dehydrateImageMessages } from '../attachments/messages.ts'
import { removeImageAttachmentFiles } from '../attachments/renditions.ts'
import {
  TOOL_IMAGE_ATTACHMENT_MAX_COUNT, createImageAttachmentsSchema, imageTransformSchema,
  type ImageAttachment, type ImageTransform,
} from '../attachments/types.ts'
import { withPdfAttachmentReferences } from '../pdf/messages.ts'
import { removePdfAttachmentFiles } from '../pdf/storage.ts'
import { pdfAttachmentSchema, pdfAttachmentsSchema, type PdfAttachment } from '../pdf/types.ts'
import type { SessionRecorder } from '../session/types.ts'

/** 附件跟随所属工具结果提交；清理只回收未被会话接受的文件。 */
export class ToolStepAttachments {
  private readonly recorder: SessionRecorder | undefined
  private readonly committedImages: ReadonlyMap<string, ImageAttachment>
  private readonly committedPdfs: ReadonlyMap<string, PdfAttachment>
  private readonly images = new Map<string, { attachments: ImageAttachment[]; transform: ImageTransform }>()
  private readonly pdfs = new Map<string, PdfAttachment[]>()
  private readonly imageKeys = new Set<string>()
  private imageCount = 0
  private imageLimit = TOOL_IMAGE_ATTACHMENT_MAX_COUNT

  constructor(
    recorder: SessionRecorder | undefined,
    committedImages: ReadonlyMap<string, ImageAttachment>,
    committedPdfs: ReadonlyMap<string, PdfAttachment>,
  ) {
    this.recorder = recorder
    this.committedImages = committedImages
    this.committedPdfs = committedPdfs
  }

  async acceptImages(id: string, values: readonly ImageAttachment[], transform: ImageTransform | undefined, limit: number): Promise<string | null> {
    const parsed = createImageAttachmentsSchema(limit).safeParse(values)
    const parsedTransform = imageTransformSchema.safeParse(transform ?? { detail: 'high' })
    if (!parsed.success || !parsedTransform.success
      || parsed.data.some((item) => item.sessionId !== this.recorder?.sessionId)) {
      return '图片工具返回了无效或不属于当前会话的附件'
    }
    const keys = parsed.data.map((item) => item.source?.kind === 'pdf-page'
      ? `${item.source.pdfAttachmentId}:${item.source.pdfSha256}:${item.source.pageNumber}` : item.id)
    this.imageLimit = Math.max(this.imageLimit, limit)
    const error = keys.some((key) => this.imageKeys.has(key))
      ? '同一模型步骤不能重复查看同一张图片，请直接使用已经返回的视觉结果'
      : this.imageCount + parsed.data.length > this.imageLimit
        ? `单个模型步骤最多查看 ${this.imageLimit} 张图片，请下一步继续` : null
    if (error) {
      const accepted = new Set([...this.images.values()].flatMap((item) =>
        item.attachments.map((attachment) => attachment.storageName)))
      await removeImageAttachmentFiles(this.recorder!.attachmentDirectory,
        parsed.data.filter((item) => !this.committedImages.has(item.storageName) && !accepted.has(item.storageName))).catch(() => {})
      return error
    }
    this.imageCount += parsed.data.length
    keys.forEach((key) => this.imageKeys.add(key))
    this.images.set(id, { attachments: parsed.data, transform: parsedTransform.data })
    return null
  }

  async acceptPdfs(id: string, values: readonly PdfAttachment[]): Promise<string | null> {
    if (!this.recorder) return 'PDF 工具附件需要会话附件存储'
    const parsed = pdfAttachmentsSchema.safeParse(values)
    const accepted = new Map([...this.pdfs.values()].flat().map((item) => [item.storageName, item]))
    const removeRejected = () => removePdfAttachmentFiles(this.recorder!.attachmentDirectory,
      values.flatMap((value) => {
        const item = pdfAttachmentSchema.safeParse(value)
        return item.success && !this.committedPdfs.has(item.data.storageName) && !accepted.has(item.data.storageName)
          ? [item.data] : []
      })).catch(() => {})
    if (!parsed.success || parsed.data.some((item) => item.sessionId !== this.recorder!.sessionId)) {
      await removeRejected()
      return 'PDF 工具返回了无效或不属于当前会话的附件'
    }
    const unique = new Map(accepted)
    for (const item of parsed.data) {
      const previous = unique.get(item.storageName) ?? this.committedPdfs.get(item.storageName)
      if (previous && JSON.stringify(previous) !== JSON.stringify(item)) {
        await removeRejected()
        return `PDF 附件元数据冲突：${item.storageName}`
      }
      unique.set(item.storageName, item)
    }
    if (!pdfAttachmentsSchema.safeParse([...unique.values()]).success) {
      await removeRejected()
      return '单个模型步骤导入的 PDF 数量或总大小超过会话附件上限'
    }
    this.pdfs.set(id, parsed.data)
    return null
  }

  forTool(id: string, message: ModelMessage) {
    const image = this.images.get(id)
    return {
      messages: dehydrateImageMessages(attachImagesToToolResults([message], image ? [{ ...image, toolCallId: id }] : [])),
      attachments: image?.attachments ?? [],
      pdfAttachments: this.pdfs.get(id) ?? [],
    }
  }

  get pdfAttachments(): PdfAttachment[] {
    return [...new Map([...this.pdfs.values()].flat().map((item) => [item.storageName, item])).values()]
  }

  pdfReferences(): ModelMessage[] {
    return this.pdfAttachments.length ? [{
      role: 'user',
      content: withPdfAttachmentReferences(
        '[应用生成：前述工具结果已将 PDF 保存为当前会话附件；需要内容时调用 ReadPdf 按页读取。]', this.pdfAttachments,
      ),
    }] : []
  }

  async discardUncommitted(): Promise<void> {
    if (!this.recorder) return
    await Promise.all([
      removeImageAttachmentFiles(this.recorder.attachmentDirectory, [...this.images.values()]
        .flatMap((item) => item.attachments).filter((item) => !this.committedImages.has(item.storageName))),
      removePdfAttachmentFiles(this.recorder.attachmentDirectory, this.pdfAttachments
        .filter((item) => !this.committedPdfs.has(item.storageName))),
    ]).catch(() => {})
  }
}
