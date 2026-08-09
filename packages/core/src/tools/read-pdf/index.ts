import { basename, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { importImageAttachments } from '../../attachments/storage.ts'
import { removeImageAttachmentFiles } from '../../attachments/renditions.ts'
import type { ImageAttachment } from '../../attachments/types.ts'
import {
  PDF_TEXT_DEFAULT_PAGES,
  PDF_TEXT_MAX_CHARS,
  PDF_TEXT_MAX_PAGES,
  PDF_VISUAL_MAX_BYTES,
  PDF_VISUAL_MAX_PAGES,
  type PdfAttachment,
} from '../../pdf/types.ts'
import type { PdfProcessor } from '../../pdf/processor.ts'
import { formatPdfTextResult, formatPdfVisualResult } from '../../pdf/content.ts'
import { buildTool, type ToolContext } from '../tool.ts'
import { resolveAllowed } from '../fs-utils.ts'
import { READ_PDF_TOOL_NAME, readPdfPrompt } from './prompt.ts'

export { READ_PDF_TOOL_NAME } from './prompt.ts'

export interface ResolvedPdfAttachment {
  attachment: PdfAttachment
  path: string
}

export interface ReadPdfToolOptions {
  attachmentDirectory: string
  sessionId: string
  processor: PdfProcessor
  supportsVisual: boolean
  resolveAttachment(attachmentId: string): ResolvedPdfAttachment | null
  resolvePageImage?(attachmentId: string, pageNumber: number): ImageAttachment | null
}

const attachmentIdSchema = z.string().uuid()

export function createReadPdfTool(options: ReadPdfToolOptions) {
  const maxPages = options.supportsVisual ? PDF_VISUAL_MAX_PAGES : PDF_TEXT_MAX_PAGES
  const defaultPages = options.supportsVisual ? PDF_VISUAL_MAX_PAGES : PDF_TEXT_DEFAULT_PAGES
  const inputSchema = z.object({
    sourceType: z.enum(['attachment', 'path']).describe('PDF 来源类型'),
    sourceValue: z.string().min(1).describe(
      'sourceType=attachment 时填写消息中 PDF 卡片的附件 ID；sourceType=path 时填写项目内或已授权的本地 PDF 路径',
    ),
    startPage: z.number().int().positive().default(1).describe('起始页，从 1 开始'),
    pageCount: z.number().int().min(1).max(maxPages).optional()
      .describe(`本次读取页数，默认 ${defaultPages}，最多 ${maxPages}`),
  }).superRefine((input, ctx) => {
    if (
      input.sourceType === 'attachment'
      && !attachmentIdSchema.safeParse(input.sourceValue).success
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceValue'],
        message: '附件来源的 sourceValue 必须是有效的 PDF 附件 ID',
      })
    }
  })

  return buildTool({
    name: READ_PDF_TOOL_NAME,
    description: options.supportsVisual
      ? '按页把 PDF 页面图交给视觉模型阅读'
      : '按页读取 PDF 文字',
    prompt: readPdfPrompt(options.supportsVisual),
    inputSchema,
    isReadOnly: true,
    kind: 'read',
    extractPaths: (input) => input.sourceType === 'path' ? [input.sourceValue] : [],
    async execute(input, ctx) {
      const source = resolvePdfSource(input.sourceType, input.sourceValue, options, ctx)
      const pageCount = input.pageCount ?? defaultPages
      const visual = options.supportsVisual

      const outputDirectory = visual
        ? await mkdtemp(join(tmpdir(), 'whycode-pdf-render-'))
        : undefined
      try {
        const result = await options.processor.readPages(
          source.path,
          visual
            ? {
                startPage: input.startPage,
                pageCount,
                mode: 'visual',
                outputDirectory: outputDirectory!,
                ...(source.expectedSha256 ? { expectedSha256: source.expectedSha256 } : {}),
              }
            : {
                startPage: input.startPage,
                pageCount,
                mode: 'text',
                ...(source.expectedSha256 ? { expectedSha256: source.expectedSha256 } : {}),
              },
          ctx.abortSignal,
        )
        if (!visual) {
          if (result.mode !== 'text') throw new Error('PDF 文字处理返回了错误结果类型')
          return {
            data: formatPdfTextResult(
              source.name,
              result.pageCount,
              result.pages,
              input.startPage,
              PDF_TEXT_MAX_CHARS,
            ),
            isError: false,
          }
        }
        if (result.mode !== 'visual') throw new Error('PDF 视觉处理返回了错误结果类型')

        const attachments: ImageAttachment[] = []
        const importedAttachments: ImageAttachment[] = []
        let totalBytes = 0
        try {
          for (const page of result.renderedPages) {
            const existing = source.attachmentId
              ? options.resolvePageImage?.(source.attachmentId, page.pageNumber)
              : null
            if (existing) {
              totalBytes += existing.byteLength
              if (totalBytes > PDF_VISUAL_MAX_BYTES) {
                throw new Error('PDF 页面图超过单次读取字节预算，请缩小页数后重试')
              }
              attachments.push(existing)
              continue
            }
            const [attachment] = await importImageAttachments(
              [{ kind: 'path', path: page.path }],
              options.attachmentDirectory,
              options.sessionId,
              ctx.abortSignal,
            )
            const namedAttachment: ImageAttachment = {
              ...attachment!,
              name: pageImageName(source.name, page.pageNumber),
              ...(source.attachmentId && source.expectedSha256 ? {
                source: {
                  kind: 'pdf-page' as const,
                  pdfAttachmentId: source.attachmentId,
                  pdfSha256: source.expectedSha256,
                  pageNumber: page.pageNumber,
                },
              } : {}),
            }
            totalBytes += namedAttachment.byteLength
            if (totalBytes > PDF_VISUAL_MAX_BYTES) {
              importedAttachments.push(namedAttachment)
              throw new Error('PDF 页面图超过单次读取字节预算，请缩小页数后重试')
            }
            attachments.push(namedAttachment)
            importedAttachments.push(namedAttachment)
          }
          return {
            data: formatPdfVisualResult(
              source.name,
              result.pageCount,
              result.renderedPages,
              input.startPage,
            ),
            isError: false,
            attachments,
            imageTransform: { detail: 'high' as const },
          }
        } catch (error) {
          await removeImageAttachmentFiles(
            options.attachmentDirectory,
            importedAttachments,
          ).catch(() => {})
          throw error
        }
      } finally {
        if (outputDirectory) {
          await rm(outputDirectory, { recursive: true, force: true }).catch(() => {})
        }
      }
    },
  })
}

function resolvePdfSource(
  sourceType: 'attachment' | 'path',
  sourceValue: string,
  options: ReadPdfToolOptions,
  ctx: ToolContext,
): { name: string; path: string; expectedSha256?: string; attachmentId?: string } {
  if (sourceType === 'path') {
    const path = resolveAllowed(ctx, sourceValue)
    return { name: basename(path), path }
  }
  const resolved = options.resolveAttachment(sourceValue)
  if (!resolved || resolved.attachment.sessionId !== options.sessionId) {
    throw new Error('PDF 附件不存在或不属于当前会话')
  }
  return {
    name: resolved.attachment.name,
    path: resolved.path,
    expectedSha256: resolved.attachment.sha256,
    attachmentId: resolved.attachment.id,
  }
}

function pageImageName(pdfName: string, pageNumber: number): string {
  const stem = pdfName.toLowerCase().endsWith('.pdf') ? pdfName.slice(0, -4) : pdfName
  return `${stem} · 第 ${pageNumber} 页.jpg`.slice(0, 255)
}
