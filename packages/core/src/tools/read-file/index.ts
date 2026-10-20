import { z } from 'zod'
import { attachmentReferenceId, fileReadKind, isAttachmentReference, parsePageRange } from '../../file-read.ts'
import { PDF_VISUAL_MAX_PAGES } from '../../pdf/limits.ts'
import { buildTool } from '../tool.ts'
import { readImage, type ReadImageOptions } from './image.ts'
import { readPdf, type ReadPdfOptions } from './pdf.ts'
import { readText } from './text.ts'
import { READ_FILE_TOOL_NAME, readFilePrompt } from './prompt.ts'

export { READ_FILE_TOOL_NAME } from './prompt.ts'

export interface ReadFileToolOptions {
  image?: ReadImageOptions
  pdf?: ReadPdfOptions
}

export function createReadFileTool(options: ReadFileToolOptions = {}) {
  return buildTool({
    name: READ_FILE_TOOL_NAME,
    description: '读取文本、图片或 PDF 文件',
    prompt: readFilePrompt(!!options.image, options.pdf?.supportsVisual),
    inputSchema: z.strictObject({
      path: z.string().min(1).describe('工作区相对路径、已授权的绝对路径，或当前会话提供的附件引用'),
      offset: z.number().int().min(1).optional().describe('文本起始行号，从 1 开始（适合长文件）'),
      limit: z.number().int().min(1).optional().describe('最多读取的文本行数（适合长文件）'),
      pages: z.string().optional().describe('PDF 页码或连续页段，例如 "3"、"1-5"；最多 20 页'),
    }).superRefine((input, ctx) => {
      const kind = fileReadKind(input.path)
      if (isAttachmentReference(input.path) && !attachmentReferenceId(input.path)) {
        ctx.addIssue({ code: 'custom', path: ['path'], message: '附件引用必须使用 attachment:// 后接当前会话提供的附件 UUID' })
      }
      for (const key of ['offset', 'limit'] as const) {
        if (kind !== 'text' && input[key] !== undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: `${key} 仅用于文本文件` })
        }
      }
      if (input.pages !== undefined) {
        const range = parsePageRange(input.pages)
        if (kind !== 'pdf' || !range || range.pageCount > PDF_VISUAL_MAX_PAGES) {
          ctx.addIssue({ code: 'custom', path: ['pages'], message: 'pages 仅用于 PDF，填写正整数页码或连续页段，每次最多 20 页' })
        }
      }
    }),
    isReadOnly: true,
    kind: 'read',
    extractPaths: (input) => isAttachmentReference(input.path) ? [] : [input.path],
    async execute(input, ctx) {
      ctx.abortSignal.throwIfAborted()
      switch (fileReadKind(input.path)) {
        case 'image':
          if (!options.image) return { data: '当前模型或会话不支持读取图片', isError: true }
          return readImage(input.path, options.image, ctx)
        case 'pdf':
          if (!options.pdf) return { data: '当前环境未提供 PDF 读取能力', isError: true }
          return readPdf(input.path, input.pages === undefined ? undefined : parsePageRange(input.pages)!, options.pdf, ctx)
        case 'text':
          return readText(input, ctx)
      }
    },
  })
}

export const readFileTool = createReadFileTool()
