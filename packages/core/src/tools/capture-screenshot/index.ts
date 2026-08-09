import { z } from 'zod'
import {
  prepareImageAttachmentForModel,
  removeImageAttachmentFiles,
} from '../../attachments/renditions.ts'
import { importImageAttachments } from '../../attachments/storage.ts'
import { buildTool } from '../tool.ts'
import {
  CAPTURE_SCREENSHOT_TOOL_NAME,
  captureScreenshotPrompt,
} from './prompt.ts'

const regionSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive().max(100_000),
  height: z.number().positive().max(100_000),
})

export function createScreenshotCaptureRequestSchema(supportsOriginalDetail: boolean) {
  return z.object({
    target: z.enum(['screen', 'window', 'region']).default('screen'),
    display_id: z.string().trim().min(1).max(100).optional(),
    window_title: z.string().trim().min(1).max(500).optional(),
    region: regionSchema.optional(),
    detail: supportsOriginalDetail
      ? z.enum(['high', 'original']).default('high')
      : z.literal('high').default('high'),
  })
    .superRefine(validateScreenshotRequest)
    .overwrite(normalizeScreenshotRequest)
}

function validateScreenshotRequest(
  input: {
    target: 'screen' | 'window' | 'region'
    display_id?: string
    region?: unknown
    window_title?: string
  },
  ctx: z.RefinementCtx,
): void {
  if (input.target === 'region' && !input.region) {
    ctx.addIssue({ code: 'custom', path: ['region'], message: '区域截图必须提供 region' })
  }
}

function normalizeScreenshotRequest<T extends {
  target: 'screen' | 'window' | 'region'
  display_id?: string
  region?: unknown
  window_title?: string
}>(input: T): T {
  const normalized = { ...input }

  // Some compatible providers materialize every optional schema property.
  // The selected target is authoritative, so unrelated fields must not alter
  // the requested capture scope or turn an otherwise valid call into a retry.
  if (normalized.target === 'window') {
    delete normalized.display_id
  } else {
    delete normalized.window_title
  }
  if (normalized.target !== 'region') {
    delete normalized.region
  }

  return normalized
}

export const screenshotCaptureRequestSchema = createScreenshotCaptureRequestSchema(true)

export type ScreenshotCaptureRequest = z.infer<typeof screenshotCaptureRequestSchema>

export interface ScreenshotCaptureResult {
  name: string
  bytes: Uint8Array
  description: string
}

export type ScreenshotCaptureHandler = (
  request: ScreenshotCaptureRequest,
  abortSignal: AbortSignal,
) => Promise<ScreenshotCaptureResult>

export function createCaptureScreenshotTool(options: {
  attachmentDirectory: string
  sessionId: string
  capture: ScreenshotCaptureHandler
  supportsOriginalDetail?: boolean
}) {
  const inputSchema = createScreenshotCaptureRequestSchema(
    options.supportsOriginalDetail === true,
  )
  return buildTool({
    name: CAPTURE_SCREENSHOT_TOOL_NAME,
    description: '截取屏幕、窗口或区域并交给视觉 Main 验证',
    prompt: captureScreenshotPrompt(options.supportsOriginalDetail === true),
    inputSchema,
    isReadOnly: true,
    kind: 'read',
    requiresStandaloneStep: true,
    initialApprovalReason: '截图会读取屏幕上其它应用可能包含的敏感内容',
    async execute(input, ctx) {
      const captured = await options.capture(input, ctx.abortSignal)
      const attachments = await importImageAttachments(
        [{ kind: 'bytes', name: captured.name, bytes: captured.bytes }],
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
          { detail: input.detail },
        )
        return {
          data: [
            captured.description,
            `截图 ${attachment.width}×${attachment.height}、${formatBytes(attachment.byteLength)}`,
            prepared.optimized
              ? `模型副本 ${prepared.width}×${prepared.height}、${formatBytes(prepared.bytes.byteLength)}`
              : '截图原图已符合模型输入边界',
            `模型像素 → 截图像素：x=modelX×${formatScale(prepared.modelToSourceScaleX)}，y=modelY×${formatScale(prepared.modelToSourceScaleY)}`,
          ].join('\n'),
          isError: false,
          attachments,
          imageTransform: { detail: input.detail },
        }
      } catch (error) {
        await removeImageAttachmentFiles(options.attachmentDirectory, attachments).catch(() => {})
        throw error
      }
    },
  })
}

function formatScale(value: number): string {
  return Number(value.toFixed(6)).toString()
}

function formatBytes(bytes: number): string {
  return bytes < 1_000_000
    ? `${(bytes / 1_000).toFixed(1)} KB`
    : `${(bytes / 1_000_000).toFixed(2)} MB`
}

export { CAPTURE_SCREENSHOT_TOOL_NAME } from './prompt.ts'
