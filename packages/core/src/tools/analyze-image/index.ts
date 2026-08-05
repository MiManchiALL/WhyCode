import { z } from 'zod'
import { createImageAttachmentIdReference } from '../../attachments/references.ts'
import { USER_IMAGE_ATTACHMENT_MAX_COUNT, type ImageAttachment } from '../../attachments/types.ts'
import type { AuxiliaryImageAnalyzer } from '../../auxiliary/image-analysis.ts'
import { buildTool } from '../tool.ts'
import { ANALYZE_IMAGE_PROMPT, ANALYZE_IMAGE_TOOL_NAME } from './prompt.ts'

export { ANALYZE_IMAGE_TOOL_NAME } from './prompt.ts'

export interface AnalyzeImageToolOptions {
  analyzer: AuxiliaryImageAnalyzer
  attachmentDirectory: string
  resolveAttachment(attachmentId: string): ImageAttachment | null
}

export function createAnalyzeImageTool(options: AnalyzeImageToolOptions) {
  return buildTool({
    name: ANALYZE_IMAGE_TOOL_NAME,
    description: '让辅助视觉模型分析当前对话中的图片',
    prompt: ANALYZE_IMAGE_PROMPT,
    inputSchema: z.object({
      attachmentIds: z.array(z.string().uuid())
        .min(1)
        .max(USER_IMAGE_ATTACHMENT_MAX_COUNT)
        .superRefine((ids, ctx) => {
          if (new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) {
            ctx.addIssue({ code: 'custom', message: '图片附件 ID 不能重复' })
          }
        })
        .describe('当前对话中待分析图片的附件 ID，顺序决定图片编号'),
      question: z.string().trim().min(1).max(8_000)
        .describe('结合完整对话改写后的独立视觉问题'),
    }),
    isReadOnly: true,
    kind: 'read',
    availableWithoutProject: true,
    async execute(input, ctx) {
      const attachments: ImageAttachment[] = []
      for (const attachmentId of input.attachmentIds) {
        const attachment = options.resolveAttachment(attachmentId)
        if (!attachment) {
          return {
            data: `图片附件不在当前活动对话中或已经失效：${attachmentId}`,
            isError: true,
          }
        }
        attachments.push(attachment)
      }
      const observation = await options.analyzer.analyze({
        question: input.question,
        attachments,
        attachmentDirectory: options.attachmentDirectory,
      }, ctx.abortSignal)
      return {
        data: [
          `辅助识图模型：${options.analyzer.modelDisplayName}`,
          `已分析附件：${attachments.map((attachment) => attachment.id).join('、')}`,
          ...attachments.map((attachment) => createImageAttachmentIdReference(attachment.id)),
          '视觉观察：',
          observation,
        ].join('\n'),
        isError: false,
      }
    },
  })
}
