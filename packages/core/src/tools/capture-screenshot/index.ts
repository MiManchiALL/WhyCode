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

export const SCREENSHOT_REGION_SCALE = 1_000

const regionSchema = z.object({
  x: z.number().min(0).max(SCREENSHOT_REGION_SCALE)
    .describe('区域左边界，0～1000 标准化坐标'),
  y: z.number().min(0).max(SCREENSHOT_REGION_SCALE)
    .describe('区域上边界，0～1000 标准化坐标'),
  width: z.number().positive().max(SCREENSHOT_REGION_SCALE)
    .describe('区域宽度，0～1000 标准化尺寸'),
  height: z.number().positive().max(SCREENSHOT_REGION_SCALE)
    .describe('区域高度，0～1000 标准化尺寸'),
}).superRefine((region, ctx) => {
  if (region.x + region.width > SCREENSHOT_REGION_SCALE) {
    ctx.addIssue({
      code: 'custom',
      path: ['width'],
      message: `区域横向范围不能超过 ${SCREENSHOT_REGION_SCALE}`,
    })
  }
  if (region.y + region.height > SCREENSHOT_REGION_SCALE) {
    ctx.addIssue({
      code: 'custom',
      path: ['height'],
      message: `区域纵向范围不能超过 ${SCREENSHOT_REGION_SCALE}`,
    })
  }
})

export function createScreenshotCaptureRequestSchema(supportsOriginalDetail: boolean) {
  return z.object({
    target: z.enum(['screen', 'window'])
      .describe('screen 截取显示器当前画面；window 截取指定应用窗口'),
    display_id: z.string().trim().max(100).optional()
      .describe('screen 使用的显示器 ID；省略时使用主显示器'),
    window_title: z.string().trim().max(500).optional()
      .describe('window 必须提供的窗口完整标题或唯一子串'),
    region: regionSchema.optional()
      .describe('screen 的可选裁剪区域，使用相对显示器的 0～1000 标准化坐标'),
    detail: (supportsOriginalDetail
      ? z.enum(['high', 'original']).default('high')
      : z.literal('high').default('high'))
      .describe('图片细节级别；常规检查使用 high'),
  })
    .superRefine(validateScreenshotRequest)
    .overwrite(normalizeScreenshotRequest)
}

function validateScreenshotRequest(
  input: {
    target: 'screen' | 'window'
    display_id?: string
    region?: unknown
    window_title?: string
  },
  ctx: z.RefinementCtx,
): void {
  if (input.target === 'window' && !input.window_title?.trim()) {
    ctx.addIssue({
      code: 'custom',
      path: ['window_title'],
      message: '窗口截图必须提供 window_title',
    })
  }
}

function normalizeScreenshotRequest<T extends {
  target: 'screen' | 'window'
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
    delete normalized.region
  } else {
    delete normalized.window_title
  }
  if (!normalized.display_id) delete normalized.display_id

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
    description: '截取应用窗口或显示器画面并进行视觉检查',
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
