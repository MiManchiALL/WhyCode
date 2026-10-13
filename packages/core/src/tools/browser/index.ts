import { z } from 'zod'
import type { ModelMessage } from 'ai'
import { estimateMessagesTokens } from '../../context/tokens.ts'
import { importImageAttachments } from '../../attachments/storage.ts'
import { buildTool, type ToolContext } from '../tool.ts'
import { BROWSER_GUIDE } from './guide.ts'

export interface BrowserExecution {
  text: string
  isError: boolean
  images: { name: string; bytes: Uint8Array }[]
}
export interface BrowserDriver {
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
      prompt: 'Inspect and interact with built-in browser pages using JavaScript. First call without code to load the API guide, then use code. Scripts are independent; pages last for the current Turn. Prefer the relevant open user page. Browser screenshots use this tool; external application screenshots use CaptureScreenshot.',
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
          this.active = true
          return { data: '浏览器指引已加入本轮上下文；本次未执行网页操作。', isError: false }
        }
        const result = await options.driver.execute(input.code, ctx)
        try {
          const attachments = result.images.length
            ? await importImageAttachments(result.images.map(image => ({ kind: 'bytes' as const, ...image })),
              options.attachmentDirectory, options.sessionId, ctx.abortSignal)
            : []
          return { data: result.text + (!options.supportsImages && result.images.length ? '\n截图已保存为附件；当前模型不直接接收图片，可使用网页快照。' : ''),
            isError: result.isError, attachments, imageTransform: { detail: 'high' as const } }
        } catch (error) {
          // 附件写入失败不能抹掉已经执行的网页动作，也不能把它们表示成未执行。
          return { data: `${result.text}\n截图附件未保存：${error instanceof Error ? error.message : String(error)}`, isError: true }
        }
      },
    })
  }
}
