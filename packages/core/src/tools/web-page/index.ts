import { buildTool } from '../tool.ts'
import { MCP_TOOL_SEARCH_NAME } from '../../mcp/search.ts'
import {
  WEB_FETCH_DEFAULT_RESULTS,
  WebPageError,
  normalizeWebFindText,
  webFetchRequestSchema,
  type WebPageReader,
} from './contract.ts'
import { formatFetchResponse, formatFindResponse } from './format.ts'
import { WEB_FETCH_TOOL_NAME, WEB_FETCH_TOOL_PROMPT } from './prompt.ts'

export function createWebFetchTool(reader: WebPageReader) {
  return buildTool({
    name: WEB_FETCH_TOOL_NAME,
    description: '读取公开网页、查找缓存正文，或导入远程 PDF',
    prompt: WEB_FETCH_TOOL_PROMPT,
    inputSchema: webFetchRequestSchema,
    isReadOnly: true,
    kind: 'read',
    behavior: (input) => ({
      kind: 'read',
      isReadOnly: true,
      initialApprovalReason: input.pattern === undefined
        ? '网页读取会向目标网站发送请求并暴露你的公网 IP 地址'
        : undefined,
    }),
    async execute(input, ctx) {
      const { pattern } = input
      try {
        ctx.abortSignal.throwIfAborted()
        if (pattern !== undefined) {
          const keywords = Array.isArray(pattern) ? pattern : [pattern]
          const request = {
            url: input.url,
            patterns: [...new Set(keywords.map(normalizeWebFindText))],
            maxResults: input.max_results ?? WEB_FETCH_DEFAULT_RESULTS,
          }
          const response = await reader.findInPage(request, ctx.abortSignal)
          return { data: formatFindResponse(request, response), isError: false }
        }
        const response = await reader.fetchPage(input, ctx.abortSignal)
        return {
          data: formatFetchResponse(input, response),
          isError: false,
          ...(response.kind === 'pdf' ? { pdfAttachments: [response.attachment] } : {}),
        }
      } catch (error) {
        const operation = pattern === undefined ? '网页读取' : '网页查找'
        if (ctx.abortSignal.aborted) return { data: `${operation}已取消`, isError: true }
        const message = error instanceof WebPageError
          ? error.message
          : `${operation}暂时不可用`
        return {
          data: pattern === undefined ? `${message}\n若已配置对应的 MCP 服务，可尝试 ${MCP_TOOL_SEARCH_NAME}。` : message,
          isError: true,
        }
      }
    },
  })
}

export * from './contract.ts'
export { WEB_FETCH_TOOL_NAME } from './prompt.ts'
