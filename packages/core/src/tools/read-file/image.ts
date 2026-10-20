import {
  prepareImageAttachmentForModel,
  removeImageAttachmentFiles,
} from '../../attachments/renditions.ts'
import { importImageAttachments } from '../../attachments/storage.ts'
import { IMAGE_ATTACHMENT_MAX_SOURCE_BYTES } from '../../attachments/types.ts'
import { localWorkspaceIO } from '../../workspace/io.ts'
import { readBoundedWorkspaceFile } from '../../workspace/read.ts'
import type { ToolContext, ToolResult } from '../tool.ts'
import { resolveAllowed } from '../fs-utils.ts'

export interface ReadImageOptions {
  attachmentDirectory: string
  sessionId: string
}

export async function readImage(path: string, options: ReadImageOptions, ctx: ToolContext): Promise<ToolResult> {
  const absolute = await resolveAllowed(ctx, path)
  const io = ctx.workspaceIO ?? localWorkspaceIO
  const attachments = await importImageAttachments(
    [{ kind: 'bytes', name: io.path.basename(absolute),
      bytes: await readBoundedWorkspaceFile(absolute, IMAGE_ATTACHMENT_MAX_SOURCE_BYTES, io, ctx.abortSignal) }],
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
      { detail: 'high' },
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
      imageTransform: { detail: 'high' },
    }
  } catch (error) {
    await removeImageAttachmentFiles(options.attachmentDirectory, attachments).catch(() => {})
    throw error
  }
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
