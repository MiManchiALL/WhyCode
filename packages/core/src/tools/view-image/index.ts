import { z } from 'zod'
import {
  prepareImageAttachmentForModel,
  removeImageAttachmentFiles,
} from '../../attachments/renditions.ts'
import { importImageAttachments } from '../../attachments/storage.ts'
import { buildTool } from '../tool.ts'
import { resolveAllowed } from '../fs-utils.ts'
import { VIEW_IMAGE_TOOL_NAME, viewImagePrompt } from './prompt.ts'

export { VIEW_IMAGE_TOOL_NAME } from './prompt.ts'

export function createViewImageTool(options: {
  attachmentDirectory: string
  sessionId: string
}) {
  return buildTool({
    name: VIEW_IMAGE_TOOL_NAME,
    description: '查看本地图片并交给视觉模型分析',
    prompt: viewImagePrompt(),
    inputSchema: z.object({
      path: z.string().min(1).describe('本地图片路径（相对项目目录或已获授权的绝对路径）'),
    }),
    isReadOnly: true,
    kind: 'read',
    extractPaths: (input) => [input.path],
    async execute(input, ctx) {
      const absolute = resolveAllowed(ctx, input.path)
      const attachments = await importImageAttachments(
        [{ kind: 'path', path: absolute }],
        options.attachmentDirectory,
        options.sessionId,
        ctx.abortSignal,
      )
      const attachment = attachments[0]!
      try {
        const prepared = await prepareImageAttachmentForModel(
          options.attachmentDirectory,
          attachment,
          ctx.abortSignal,
        )
        const rendition = prepared.optimized
          ? `模型副本 ${prepared.width}×${prepared.height}、${formatBytes(prepared.bytes.byteLength)}、${prepared.mediaType}`
          : '原图已符合模型输入边界，无需生成衍生图'
        return {
          data: [
            `已读取图片：${attachment.name}`,
            `原图 ${attachment.width}×${attachment.height}、${formatBytes(attachment.byteLength)}、${attachment.mediaType}`,
            rendition,
          ].join('\n'),
          isError: false,
          attachments,
        }
      } catch (error) {
        await removeImageAttachmentFiles(options.attachmentDirectory, attachments).catch(() => {})
        throw error
      }
    },
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`
  return `${(bytes / 1_000_000).toFixed(2)} MB`
}
