import { z } from 'zod'
import {
  prepareImageAttachmentForModel,
  removeImageAttachmentFiles,
} from '../../attachments/renditions.ts'
import { importImageAttachments } from '../../attachments/storage.ts'
import { imageRegionSchema } from '../../attachments/types.ts'
import { buildTool } from '../tool.ts'
import { resolveAllowed } from '../fs-utils.ts'
import { VIEW_IMAGE_TOOL_NAME, viewImagePrompt } from './prompt.ts'

export { VIEW_IMAGE_TOOL_NAME } from './prompt.ts'

export function createViewImageTool(options: {
  attachmentDirectory: string
  sessionId: string
  supportsOriginalDetail?: boolean
}) {
  const detailSchema = options.supportsOriginalDetail
    ? z.enum(['high', 'original']).default('high')
    : z.literal('high').default('high')
  return buildTool({
    name: VIEW_IMAGE_TOOL_NAME,
    description: '查看本地图片并交给视觉模型分析',
    prompt: viewImagePrompt(options.supportsOriginalDetail === true),
    inputSchema: z.object({
      path: z.string().min(1).describe('本地图片路径（相对项目目录或已获授权的绝对路径）'),
      detail: detailSchema,
      region: imageRegionSchema.optional().describe('可选裁剪区域；坐标基于 autoOrient 后的源图像素'),
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
          { detail: input.detail, ...(input.region ? { region: input.region } : {}) },
        )
        const rendition = prepared.optimized
          ? `模型副本 ${prepared.width}×${prepared.height}、${formatBytes(prepared.bytes.byteLength)}、${prepared.mediaType}`
          : '原图已符合模型输入边界，无需生成衍生图'
        return {
          data: [
            `已读取图片：${attachment.name}`,
            `原图 ${attachment.width}×${attachment.height}、${formatBytes(attachment.byteLength)}、${attachment.mediaType}`,
            `autoOrient 后源图 ${prepared.sourceWidth}×${prepared.sourceHeight}；读取区域 ${formatRegion(prepared.selectedRegion)}`,
            rendition,
            `模型像素 → 源图区域：x=${prepared.selectedRegion.x}+modelX×${formatScale(prepared.modelToSourceScaleX)}，y=${prepared.selectedRegion.y}+modelY×${formatScale(prepared.modelToSourceScaleY)}`,
          ].join('\n'),
          isError: false,
          attachments,
          imageTransform: {
            detail: input.detail,
            ...(input.region ? { region: input.region } : {}),
          },
        }
      } catch (error) {
        await removeImageAttachmentFiles(options.attachmentDirectory, attachments).catch(() => {})
        throw error
      }
    },
  })
}

function formatRegion(region: { x: number; y: number; width: number; height: number }): string {
  return `(${region.x},${region.y},${region.width},${region.height})`
}

function formatScale(value: number): string {
  return Number(value.toFixed(6)).toString()
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`
  return `${(bytes / 1_000_000).toFixed(2)} MB`
}
