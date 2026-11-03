import { z } from 'zod'
import type { ModelMessage } from 'ai'
import { estimateMessagesTokens } from '../../context/tokens.ts'
import { importImageAttachments } from '../../attachments/storage.ts'
import { prepareImageAttachmentForModel, removeImageAttachmentFiles } from '../../attachments/renditions.ts'
import type { ImageAttachment } from '../../attachments/types.ts'
import { buildTool, type ToolContext } from '../tool.ts'
import { BROWSER_GUIDE } from './guide.ts'

export interface BrowserExecution {
  text: string
  isError: boolean
  images: { name: string; bytes: Uint8Array }[]
}
export interface BrowserPage {
  id: string; url: string; title: string
  agent: boolean; selected: boolean; active: boolean; openerId?: string
}
export interface BrowserDriver {
  listPages(): BrowserPage[]
  execute(code: string, context: Pick<ToolContext, 'abortSignal' | 'turnId' | 'toolCallId' | 'onProgress'>): Promise<BrowserExecution>
  finishTurn(turnId: string): Promise<void>
}

/** 指引只投影到当前根 Turn 的请求末尾，不反复写入历史或改变稳定工具定义。 */
export class BrowserTurnContext {
  private active = false

  project(messages: readonly ModelMessage[], include = true): ModelMessage[] {
    return this.active && include
      ? [...messages, { role: 'user', content: BROWSER_GUIDE }]
      : [...messages]
  }

  tokenEstimate(): number { return estimateMessagesTokens(this.project([])) }
  finish(): void { this.active = false }

  tool(options: { driver: BrowserDriver; attachmentDirectory: string; sessionId: string; supportsImages: boolean }) {
    return buildTool({
      name: 'Browser',
      description: '浏览和操作内置网页',
      prompt: 'Inspect and interact with built-in browser pages using JavaScript. First call without code to load the API guide and this conversation\'s current pages. Prefer claiming a relevant existing page by its observed id; open a URL if none fits. Use browser.tabs() to refresh the list when needed. Scripts are independent; pages are handed back to the user after the Turn. Use this tool for browser screenshots, CaptureScreenshot for external applications.',
      inputSchema: z.object({
        code: z.string().max(32_000).optional().describe('JavaScript using the loaded browser API; omit on first use'),
        description: z.string().max(120).optional().describe('Brief description of this browser action'),
      }),
      isReadOnly: false,
      kind: 'execute',
      initialApprovalReason: '浏览器操作会读取网页，并可点击、输入或提交网页内容',
      execute: async (input, ctx) => {
        ctx.abortSignal.throwIfAborted()
        if (!this.active || !input.code) {
          const pages = options.driver.listPages()
          this.active = true
          return { data: `浏览器指引已加入本轮上下文；本次未执行网页操作。\n当前会话网页：${JSON.stringify(pages)}`, isError: false }
        }
        const result = await options.driver.execute(input.code, ctx)
        let attachments: ImageAttachment[] = []
        try {
          attachments = result.images.length
            ? await importImageAttachments(result.images.map(image => ({ kind: 'bytes' as const, ...image })),
              options.attachmentDirectory, options.sessionId, ctx.abortSignal)
            : []
          const coordinates: string[] = []
          if (options.supportsImages) for (const attachment of attachments) {
            const image = await prepareImageAttachmentForModel(options.attachmentDirectory, attachment, ctx.abortSignal, { detail: 'high' })
            coordinates.push(`${attachment.name}: viewport ${attachment.width}×${attachment.height} CSS px; model image ${image.width}×${image.height} px; click x=imageX*${image.modelToSourceScaleX}, y=imageY*${image.modelToSourceScaleY}`)
          }
          const coordinateInfo = coordinates.length
            ? `\n截图坐标：browser.click({x,y}) 使用网页视口 CSS 像素，原点为网页内容左上角，x 向右、y 向下。\n${coordinates.join('\n')}\n若定位结果使用 0–1000 归一化坐标，先换算 x=normalizedX/1000*viewportWidth，y=normalizedY/1000*viewportHeight；不要直接作为点击像素。`
            : ''
          return { data: result.text + coordinateInfo + (!options.supportsImages && result.images.length ? '\n截图已保存为附件；当前模型不直接接收图片，可使用网页快照。' : ''),
            isError: result.isError, attachments, imageTransform: { detail: 'high' as const } }
        } catch (error) {
          await removeImageAttachmentFiles(options.attachmentDirectory, attachments).catch(() => {})
          // 截图处理失败不能抹掉已经执行的网页动作，也不能把它们表示成未执行。
          return { data: `${result.text}\n截图处理失败：${error instanceof Error ? error.message : String(error)}`, isError: true }
        }
      },
    })
  }
}
