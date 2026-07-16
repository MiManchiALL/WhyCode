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
  PDF_VISUAL_MAX_PAGES,
  type PdfAttachment,
} from '../../pdf/types.ts'
import type { PdfProcessor } from '../../pdf/processor.ts'
import { formatPdfTextResult } from '../../pdf/content.ts'
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
  supportsProjectPaths: boolean
  resolveAttachment(attachmentId: string): ResolvedPdfAttachment | null
  resolvePageImage?(attachmentId: string, pageNumber: number): ImageAttachment | null
}

const attachmentIdSchema = z.string().uuid()

export function createReadPdfTool(options: ReadPdfToolOptions) {
  const sourceTypeSchema = options.supportsProjectPaths
    ? z.enum(['attachment', 'path'])
    : z.literal('attachment')
  const sourceValueDescription = options.supportsProjectPaths
    ? 'sourceType=attachment 时填写消息中 PDF 卡片的附件 ID；sourceType=path 时填写项目内或已授权的本地 PDF 路径'
    : '消息中 PDF 卡片显示的附件 ID'
  const modeSchema = options.supportsVisual
    ? z.enum(['auto', 'text', 'visual']).default('auto')
    : z.literal('text').default('text')
  const modeDescription = options.supportsVisual
    ? 'auto=文字+页面图（默认）；text=仅文字；visual 为 auto 的兼容别名'
    : '当前模型只支持 text=仅文字'
  const inputSchema = z.object({
    sourceType: sourceTypeSchema.describe('PDF 来源类型'),
    sourceValue: z.string().min(1).describe(sourceValueDescription),
    startPage: z.number().int().positive().default(1).describe('起始页，从 1 开始'),
    pageCount: z.number().int().min(1).max(PDF_TEXT_MAX_PAGES).optional()
      .describe('本次读取页数；文字默认 5，视觉默认 4'),
    mode: modeSchema.describe(modeDescription),
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
      ? '按页读取 PDF，默认同时获得文字和页面图'
      : '按页读取 PDF 文字',
    prompt: readPdfPrompt(options.supportsVisual, options.supportsProjectPaths),
    inputSchema,
    isReadOnly: true,
    kind: 'read',
    availableWithoutProject: true,
    extractPaths: (input) => input.sourceType === 'path' ? [input.sourceValue] : [],
    async execute(input, ctx) {
      const source = resolvePdfSource(input.sourceType, input.sourceValue, options, ctx)
      const render = input.mode !== 'text'
      const pageCount = input.pageCount ?? (render ? PDF_VISUAL_MAX_PAGES : PDF_TEXT_DEFAULT_PAGES)
      if (render && pageCount > PDF_VISUAL_MAX_PAGES) {
        return {
          data: `视觉模式每次最多读取 ${PDF_VISUAL_MAX_PAGES} 页，请缩小 pageCount`,
          isError: true,
        }
      }

      const outputDirectory = render
        ? await mkdtemp(join(tmpdir(), 'whycode-pdf-render-'))
        : undefined
      try {
        const result = await options.processor.readPages(source.path, {
          startPage: input.startPage,
          pageCount,
          render,
          ...(source.expectedSha256 ? { expectedSha256: source.expectedSha256 } : {}),
          ...(outputDirectory ? { outputDirectory } : {}),
        }, ctx.abortSignal)
        const data = formatPdfTextResult(
          source.name,
          result.pageCount,
          result.pages,
          input.startPage,
          PDF_TEXT_MAX_CHARS,
        )
        if (!render) return { data, isError: false }

        const attachments: ImageAttachment[] = []
        const importedAttachments: ImageAttachment[] = []
        try {
          for (const page of result.renderedPages) {
            const existing = source.attachmentId
              ? options.resolvePageImage?.(source.attachmentId, page.pageNumber)
              : null
            if (existing) {
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
            attachments.push(namedAttachment)
            importedAttachments.push(namedAttachment)
          }
          return {
            data,
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
    if (!options.supportsProjectPaths) throw new Error('当前会话不允许读取本地 PDF 路径')
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
  return `${stem} · 第 ${pageNumber} 页.png`.slice(0, 255)
}
