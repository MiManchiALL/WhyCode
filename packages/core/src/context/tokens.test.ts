import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import {
  estimateContextTokens,
  estimateMessageTokens,
  estimateRequestContextOverhead,
} from './tokens.ts'

describe('视觉上下文估算', () => {
  it('页面图不按 Base64 字符计费，并为高分辨率页面保留固定预算', () => {
    const message: ModelMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'PDF page' },
        { type: 'file', data: 'x'.repeat(1_000_000), mediaType: 'image/png' },
      ],
    }
    const tokens = estimateMessageTokens(message)
    assert.ok(tokens >= 3_000 && tokens < 3_100)
  })

  it('usage 基线之后的宿主工具结果和页面图仍进入估算', () => {
    const messages: ModelMessage[] = [
      { role: 'assistant', content: '调用工具' },
      { role: 'tool', content: [{
        type: 'tool-result',
        toolCallId: 'pdf-1',
        toolName: 'ReadPdf',
        output: {
          type: 'content',
          value: [
            { type: 'text', text: 'x'.repeat(4_000) },
            {
              type: 'file',
              data: { type: 'data', data: 'whycode-attachment-ref:v1:page.png' },
              filename: 'page.png',
              mediaType: 'image/png',
            },
          ],
        },
      }] },
    ]
    const estimate = estimateContextTokens(messages, {
      usageTokens: 100,
      coveredMessageCount: 1,
    })
    assert.ok(estimate > 4_000)
  })

  it('协议元数据不按提示词正文计费，但工具参数中的同名业务字段仍保留', () => {
    const plainReasoning = {
      role: 'assistant',
      content: [{ type: 'reasoning', text: '可见推理' }],
    } as ModelMessage
    const reasoningWithMetadata = {
      role: 'assistant',
      content: [{
        type: 'reasoning',
        text: '可见推理',
        providerOptions: {
          openai: { reasoningEncryptedContent: 'x'.repeat(200_000) },
        },
      }],
    } as ModelMessage
    const toolArgument = {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'Probe',
        input: { providerOptions: 'x'.repeat(4_000) },
      }],
    } as ModelMessage
    const toolResult = {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'Probe',
        output: {
          type: 'text',
          value: 'ok',
          providerOptions: { provider: { signature: 'x'.repeat(200_000) } },
        },
      }],
    } as ModelMessage
    const plainToolResult = {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'Probe',
        output: { type: 'text', value: 'ok' },
      }],
    } as ModelMessage

    assert.equal(
      estimateMessageTokens(reasoningWithMetadata),
      estimateMessageTokens(plainReasoning),
    )
    assert.equal(estimateMessageTokens(toolResult), estimateMessageTokens(plainToolResult))
    assert.ok(estimateMessageTokens(toolArgument) > 1_000)
  })

  it('无 Provider usage 时计入固定请求开销，有基线时不重复计算', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'hello' }]
    const messageTokens = estimateContextTokens(messages, null)

    assert.equal(estimateContextTokens(messages, null, 1_000), messageTokens + 1_000)
    assert.equal(estimateContextTokens(messages, {
      usageTokens: 800,
      coveredMessageCount: messages.length,
    }, 1_000), 800)
  })

  it('按真实 System 与工具 schema 生成固定请求开销', async () => {
    const overhead = await estimateRequestContextOverhead(
      '你是 WhyCode。',
      {
        ReadFile: tool({
          description: '读取文件',
          inputSchema: z.object({ path: z.string() }),
        }),
      },
    )

    assert.ok(overhead.systemPromptTokens > 0)
    assert.ok(overhead.toolTokens > 0)
  })
})
