import { join } from 'node:path'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { importImageAttachments } from '../../attachments/storage.ts'
import { removeImageAttachmentFiles } from '../../attachments/renditions.ts'
import type { ImageAttachment } from '../../attachments/types.ts'
import {
  PDF_TEXT_DEFAULT_PAGES,
  PDF_ATTACHMENT_MAX_SOURCE_BYTES,
  PDF_TEXT_MAX_CHARS,
  PDF_VISUAL_MAX_BYTES,
  PDF_VISUAL_MAX_PAGES,
  type PdfAttachment,
} from '../../pdf/types.ts'
import type { PdfProcessor } from '../../pdf/processor.ts'
import { formatPdfTextResult, formatPdfVisualResult } from '../../pdf/content.ts'
import type { ToolContext, ToolResult } from '../tool.ts'
import { resolveAllowed } from '../fs-utils.ts'
import { attachmentReferenceId, isAttachmentReference } from '../../file-read.ts'
import { localWorkspaceIO } from '../../workspace/io.ts'
import { readBoundedWorkspaceFile } from '../../workspace/read.ts'

export interface ResolvedPdfAttachment {
  attachment: PdfAttachment
  path: string
}

export interface ReadPdfOptions {
  attachmentDirectory: string
  sessionId: string
  processor: PdfProcessor
  supportsVisual: boolean
  resolveAttachment(attachmentId: string): ResolvedPdfAttachment | null
  resolvePageImage?(attachmentId: string, pageNumber: number): ImageAttachment | null
}

export async function readPdf(
  path: string,
  range: { startPage: number; pageCount: number } | undefined,
  options: ReadPdfOptions,
  ctx: ToolContext,
): Promise<ToolResult> {
  const startPage = range?.startPage ?? 1
  const source = await resolvePdfSource(path, options, ctx)
  const pageCount = range?.pageCount ?? (options.supportsVisual ? PDF_VISUAL_MAX_PAGES : PDF_TEXT_DEFAULT_PAGES)
  const visual = options.supportsVisual
  const io = ctx.workspaceIO ?? localWorkspaceIO
  const remoteFile = !isAttachmentReference(path) && io.identity !== 'local'

  const outputDirectory = visual || remoteFile
    ? await mkdtemp(join(tmpdir(), 'whycode-pdf-render-'))
    : undefined
  try {
    let localPath = source.path
    if (remoteFile) {
      localPath = join(outputDirectory!, 'source.pdf')
      const bytes = await readBoundedWorkspaceFile(source.path, PDF_ATTACHMENT_MAX_SOURCE_BYTES, io, ctx.abortSignal)
      await writeFile(localPath, bytes, { mode: 0o600, flag: 'wx', signal: ctx.abortSignal })
    }
    const result = await options.processor.readPages(
      localPath,
      visual
        ? {
            startPage,
            pageCount,
            mode: 'visual',
            outputDirectory: outputDirectory!,
            ...(source.expectedSha256 ? { expectedSha256: source.expectedSha256 } : {}),
          }
        : {
            startPage,
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
          startPage,
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
          startPage,
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
}

async function resolvePdfSource(
  sourceValue: string,
  options: ReadPdfOptions,
  ctx: ToolContext,
): Promise<{ name: string; path: string; expectedSha256?: string; attachmentId?: string }> {
  if (!isAttachmentReference(sourceValue)) {
    const path = await resolveAllowed(ctx, sourceValue)
    return { name: (ctx.workspaceIO ?? localWorkspaceIO).path.basename(path), path }
  }
  const id = attachmentReferenceId(sourceValue)
  if (!id) throw new Error('无效的 PDF 附件引用')
  const resolved = options.resolveAttachment(id)
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
