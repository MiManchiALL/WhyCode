import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText, tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import { compactMessages } from './compact.ts'

describe('摘要请求保留普通请求的工具声明', () => {
  const providers = {
    Messages: (fetch: typeof globalThis.fetch) => createAnthropic({ apiKey: 'test', fetch })('claude-test'),
    Responses: (fetch: typeof globalThis.fetch) => createOpenAI({ apiKey: 'test', fetch }).responses('gpt-test'),
    Chat: (fetch: typeof globalThis.fetch) => createOpenAICompatible({
      name: 'test', baseURL: 'http://localhost', fetch,
    })('chat-test'),
    DeepSeek: (fetch: typeof globalThis.fetch) => createDeepSeek({ apiKey: 'test', fetch })('deepseek-chat'),
  }

  for (const [name, createModel] of Object.entries(providers)) {
    it(`${name} 最终 API 请求的 tools 内容与顺序一致`, async () => {
      const requests: unknown[] = []
      const model = createModel(async (_input, init) => {
        assert.ok(typeof init?.body === 'string')
        requests.push(JSON.parse(init.body))
        return Response.json({
          type: 'error', error: { type: 'invalid_request_error', message: 'request captured' },
        }, { status: 400 })
      })
      const tools = {
        ToolSearch: tool({
          description: '检索工具。服务器初始化说明：可读取工作区资料。',
          inputSchema: z.object({ query: z.string().describe('检索词') }),
        }),
        McpRead: tool({
          description: '读取已发现的 MCP 资源。',
          inputSchema: z.object({ path: z.string(), format: z.enum(['text', 'json']).optional() }),
        }),
      }
      const messages: ModelMessage[] = [
        { role: 'user', content: '查看资料并说明结果。' },
        { role: 'assistant', content: '资料已核对。' },
      ]
      await assert.rejects(generateText({
        model, tools, messages, system: '普通任务提示词', maxRetries: 0,
      }), /request captured/)
      await assert.rejects(compactMessages({
        model, tools, messages, mode: 'manual',
        capabilities: { contextWindow: 128_000, maxOutput: 20_000 },
        abortSignal: new AbortController().signal,
      }), /request captured/)

      assert.equal(requests.length, 2)
      const requestSchema = z.object({ tools: z.array(z.unknown()).length(2) })
      const normal = requestSchema.parse(requests[0])
      const summary = requestSchema.parse(requests[1])
      assert.deepEqual(summary.tools, normal.tools)
    })
  }
})
