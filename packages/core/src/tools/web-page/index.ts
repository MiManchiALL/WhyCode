import { buildTool } from '../tool.ts'
import {
  WebPageError,
  webFetchRequestSchema,
  webFindRequestSchema,
  type WebFetchHandler,
  type WebFindHandler,
} from './contract.ts'
import { formatFetchResponse, formatFindResponse } from './format.ts'
import {
  WEB_FETCH_MCP_FALLBACK_HINT,
  WEB_FETCH_TOOL_NAME,
  WEB_FETCH_TOOL_PROMPT,
  WEB_FIND_TOOL_NAME,
  WEB_FIND_TOOL_PROMPT,
} from './prompt.ts'

export function createWebFetchTool(options: { fetchPage: WebFetchHandler }) {
  return buildTool({
    name: WEB_FETCH_TOOL_NAME,
    description: '读取公开网页，或将远程 PDF 保存为可用 ReadPdf 读取的会话附件',
    prompt: WEB_FETCH_TOOL_PROMPT,
    inputSchema: webFetchRequestSchema,
    isReadOnly: true,
    kind: 'read',
    initialApprovalReason: '网页读取会向目标网站发送请求并暴露你的公网 IP 地址',
    async execute(input, ctx) {
      try {
        const response = await options.fetchPage({
          url: input.url,
          ...(input.offset !== undefined ? { offset: input.offset } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        }, ctx.abortSignal)
        return {
          data: formatFetchResponse(input, response),
          isError: false,
          ...(response.kind === 'pdf' ? { pdfAttachments: [response.attachment] } : {}),
        }
      } catch (error) {
        if (ctx.abortSignal.aborted) {
          return { data: '网页读取已取消', isError: true }
        }
        const message = error instanceof WebPageError
          ? error.message
          : '网页读取暂时不可用'
        return {
          data: `${message}\n${WEB_FETCH_MCP_FALLBACK_HINT}`,
          isError: true,
        }
      }
    },
  })
}

export function createWebFindTool(options: { findInPage: WebFindHandler }) {
  return buildTool({
    name: WEB_FIND_TOOL_NAME,
    description: '在本会话已读取网页的正文中按稳定行号查找文本',
    prompt: WEB_FIND_TOOL_PROMPT,
    inputSchema: webFindRequestSchema,
    isReadOnly: true,
    kind: 'read',
    async execute(input, ctx) {
      try {
        const response = await options.findInPage({
          url: input.url,
          pattern: input.pattern,
          context: input.context,
          maxResults: input.max_results,
        }, ctx.abortSignal)
        return { data: formatFindResponse(input, response), isError: false }
      } catch (error) {
        return {
          data: ctx.abortSignal.aborted
            ? '网页查找已取消'
            : error instanceof WebPageError
              ? error.message
              : '网页查找暂时不可用',
          isError: true,
        }
      }
    },
  })
}

export * from './contract.ts'
export {
  WEB_FETCH_TOOL_NAME,
  WEB_FIND_TOOL_NAME,
} from './prompt.ts'
