import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import {
  estimateContextTokens,
  estimateMessageTokens,
  estimateRequestContextBreakdown,
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

  it('按真实 System、工具 schema 与消息生成可解释分项', async () => {
    const breakdown = await estimateRequestContextBreakdown(
      '你是 WhyCode。',
      [{ role: 'user', content: '检查这个项目' }],
      {
        ReadFile: tool({
          description: '读取文件',
          inputSchema: z.object({ path: z.string() }),
        }),
      },
    )

    assert.ok(breakdown.systemPromptTokens > 0)
    assert.ok(breakdown.toolTokens > 0)
    assert.ok(breakdown.messageTokens > 0)
  })
})
