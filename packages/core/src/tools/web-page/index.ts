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
  WEB_FETCH_TOOL_NAME,
  WEB_FETCH_TOOL_PROMPT,
  WEB_FIND_TOOL_NAME,
  WEB_FIND_TOOL_PROMPT,
} from './prompt.ts'

export function createWebFetchTool(options: { fetchPage: WebFetchHandler }) {
  return buildTool({
    name: WEB_FETCH_TOOL_NAME,
    description: '读取公开网页或远程 PDF，并返回有界、带行号的 Markdown 正文',
    prompt: WEB_FETCH_TOOL_PROMPT,
    inputSchema: webFetchRequestSchema,
    isReadOnly: true,
    kind: 'read',
    availableWithoutProject: true,
    initialApprovalReason: '网页读取会向目标网站发送请求并暴露你的公网 IP 地址',
    async execute(input, ctx) {
      try {
        const response = await options.fetchPage({
          url: input.url,
          offset: input.offset,
          limit: input.limit,
        }, ctx.abortSignal)
        return { data: formatFetchResponse(input, response), isError: false }
      } catch (error) {
        return {
          data: ctx.abortSignal.aborted
            ? '网页读取已取消'
            : error instanceof WebPageError
              ? error.message
              : '网页读取暂时不可用',
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
    availableWithoutProject: true,
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
