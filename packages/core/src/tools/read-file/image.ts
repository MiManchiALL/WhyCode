import {
  prepareImageAttachmentForModel,
  removeImageAttachmentFiles,
} from '../../attachments/renditions.ts'
import { importImageAttachments } from '../../attachments/storage.ts'
import { IMAGE_ATTACHMENT_MAX_SOURCE_BYTES } from '../../attachments/types.ts'
import { localWorkspaceIO } from '../../workspace/io.ts'
import { readBoundedWorkspaceFile } from '../../workspace/read.ts'
import type { ToolContext, ToolResult } from '../tool.ts'
import { resolveAllowed, rethrowTargetError } from '../fs-utils.ts'

export interface ReadImageOptions {
  attachmentDirectory: string
  sessionId: string
}

export async function readImage(path: string, options: ReadImageOptions, ctx: ToolContext): Promise<ToolResult> {
  const absolute = await resolveAllowed(ctx, path)
  const io = ctx.workspaceIO ?? localWorkspaceIO
  const bytes = await readBoundedWorkspaceFile(absolute, IMAGE_ATTACHMENT_MAX_SOURCE_BYTES, io, ctx.abortSignal)
    .catch(error => rethrowTargetError(error, '文件'))
  const attachments = await importImageAttachments(
    [{ kind: 'bytes', name: io.path.basename(absolute), bytes }],
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
    const size = `${prepared.width}×${prepared.height}`
    const source = prepared.autoOriented ? '转正后的原图' : '原图'
    const x = prepared.modelToSourceScaleX
    const y = prepared.modelToSourceScaleY
    let data = prepared.autoOriented ? `${source}尺寸 ${size}` : `图片尺寸 ${size}`
    if (x !== 1 || y !== 1) {
      const scale = x === y ? `坐标乘 ${formatScale(x)}` : `x 乘 ${formatScale(x)}、y 乘 ${formatScale(y)}`
      data = `${source} ${prepared.sourceWidth}×${prepared.sourceHeight}，显示为 ${size}。${scale} 可换算为${source}坐标。`
    }
    return {
      data,
      isError: false,
      attachments,
      imageTransform: { detail: 'high' },
    }
  } catch (error) {
    await removeImageAttachmentFiles(options.attachmentDirectory, attachments).catch(() => {})
    throw error
  }
}

function formatScale(value: number): string {
  return Number(value.toFixed(6)).toString()
}
