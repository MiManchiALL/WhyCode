import { basename, join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { importImageAttachments } from '../../attachments/storage.ts'
import { removeImageAttachmentFiles } from '../../attachments/renditions.ts'
import type { ImageAttachment } from '../../attachments/types.ts'
import {
  OFFICE_RENDER_MAX_PAGES,
  OFFICE_RENDER_OVERVIEW_MAX_PAGES,
  type OfficeProcessor,
} from '../../office/types.ts'
import { buildTool } from '../tool.ts'
import { resolveAllowed } from '../fs-utils.ts'
import { createOfficeOverview } from './montage.ts'
import { RENDER_OFFICE_PROMPT, RENDER_OFFICE_TOOL_NAME } from './prompt.ts'

export { RENDER_OFFICE_TOOL_NAME } from './prompt.ts'

export function createRenderOfficeTool(options: {
  processor: OfficeProcessor
  attachmentDirectory: string
  sessionId: string
}) {
  return buildTool({
    name: RENDER_OFFICE_TOOL_NAME,
    description: '后台渲染 Office 文件并交给视觉模型检查',
    prompt: RENDER_OFFICE_PROMPT,
    inputSchema: z.object({
      path: z.string().min(1).describe('项目内或已授权的 DOCX/PPTX/XLSX 路径'),
      view: z.enum(['pages', 'overview']).default('pages')
        .describe('pages 返回逐页大图；overview 把一段页面合成一张整套总览图'),
      startPage: z.number().int().positive().default(1).describe('渲染起始页，从 1 开始'),
      pageCount: z.number().int().min(1).max(OFFICE_RENDER_OVERVIEW_MAX_PAGES)
        .default(OFFICE_RENDER_MAX_PAGES).describe('pages 最多 4 页；overview 最多 50 页'),
    }).superRefine((input, ctx) => {
      if (input.view === 'pages' && input.pageCount > OFFICE_RENDER_MAX_PAGES) {
        ctx.addIssue({
          code: 'custom',
          path: ['pageCount'],
          message: `pages 视图每次最多渲染 ${OFFICE_RENDER_MAX_PAGES} 页`,
        })
      }
    }),
    isReadOnly: true,
    kind: 'read',
    requiresStandaloneStep: true,
    extractPaths: (input) => [input.path],
    async execute(input, ctx) {
      const source = resolveAllowed(ctx, input.path)
      const outputDirectory = await mkdtemp(join(tmpdir(), 'whycode-office-render-'))
      const imported: ImageAttachment[] = []
      try {
        const result = await options.processor.renderPages(source, {
          startPage: input.startPage,
          pageCount: input.pageCount,
          outputDirectory,
          view: input.view,
        }, ctx.abortSignal)
        if (input.view === 'overview') {
          const overviewPath = join(outputDirectory, 'overview.jpg')
          await createOfficeOverview(result.renderedPages, overviewPath, ctx.abortSignal)
          const [attachment] = await importImageAttachments(
            [{ kind: 'path', path: overviewPath }],
            options.attachmentDirectory,
            options.sessionId,
            ctx.abortSignal,
          )
          if (!attachment) throw new Error('Office 总览没有生成图片附件')
          imported.push({
            ...attachment,
            name: overviewImageName(
              basename(source),
              result.renderedPages[0]!.pageNumber,
              result.renderedPages.at(-1)!.pageNumber,
            ),
          })
        } else {
          for (const page of result.renderedPages) {
            const [attachment] = await importImageAttachments(
              [{ kind: 'path', path: page.path }],
              options.attachmentDirectory,
              options.sessionId,
              ctx.abortSignal,
            )
            if (!attachment) throw new Error('Office 渲染页没有生成图片附件')
            imported.push({
              ...attachment,
              name: pageImageName(basename(source), page.pageNumber),
            })
          }
        }
        const lastPage = result.renderedPages.at(-1)?.pageNumber ?? input.startPage
        return {
          data: [
            `已用 ${rendererName(result.renderer)} 在后台渲染 ${basename(source)}${input.view === 'overview' ? ' 总览' : ''}。`,
            `总页数 ${result.pageCount}；本次返回第 ${input.startPage}-${lastPage} 页${input.view === 'overview' ? '的整套构图总览' : ''}。`,
            lastPage < result.pageCount
              ? `下一批从 startPage=${lastPage + 1} 继续。`
              : '已到末页；必须结合 InspectOffice 的结构结果完成复核。',
            ...(input.view === 'overview'
              ? ['总览用于检查页序、构图轮廓和视觉节奏；文字适配、裁切与对象细节仍须用 pages 逐页检查。']
              : []),
          ].join('\n'),
          isError: false,
          attachments: imported,
          imageTransform: { detail: 'high' as const },
        }
      } catch (error) {
        await removeImageAttachmentFiles(options.attachmentDirectory, imported).catch(() => {})
        throw error
      } finally {
        await rm(outputDirectory, { recursive: true, force: true }).catch(() => {})
      }
    },
  })
}

function pageImageName(sourceName: string, pageNumber: number): string {
  return `${sourceName} · 渲染第 ${pageNumber} 页.jpg`.slice(0, 255)
}

function overviewImageName(sourceName: string, startPage: number, endPage: number): string {
  return `${sourceName} · 总览第 ${startPage}-${endPage} 页.jpg`.slice(0, 255)
}

function rendererName(renderer: 'libreoffice' | 'microsoft-office'): string {
  return renderer === 'libreoffice' ? 'LibreOffice headless' : 'Microsoft Office 隐藏实例'
}
