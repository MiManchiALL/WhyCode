import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { modelMessageSchema, type ModelMessage } from 'ai'
import {
  adaptMessagesForProvider,
  normalizeResponseMessagesForProvider,
} from './message-adapter.ts'

describe('多模态工具结果协议适配', () => {
  it('Anthropic Messages 与 OpenAI Responses 保留原生 tool_call_id 图片结果', () => {
    const canonical = history()
    for (const protocol of ['anthropic-messages', 'openai-responses'] as const) {
      const adapted = adaptMessagesForProvider(canonical, protocol)
      assert.deepEqual(adapted, canonical)
      assert.equal(adapted.some((message) => message.role === 'user'), false)
      assert.equal(toolImageCount(adapted), 2)
    }
  })

  it('OpenAI Chat 在全部并行工具结果之后只追加一个相邻图片消息', () => {
    const canonical = history()
    const adapted = adaptMessagesForProvider(canonical, 'openai-chat')

    assert.deepEqual(adapted.map((message) => message.role), [
      'assistant', 'tool', 'tool', 'user', 'assistant',
    ])
    assert.equal(toolImageCount(adapted), 0)
    assert.equal(JSON.stringify(adapted).match(/iVBORw0KGgo/g)?.length, 2)
    assert.match(JSON.stringify(adapted[1]), /tool_call_id=call-a/)
    assert.match(JSON.stringify(adapted[2]), /tool_call_id=call-b/)
    assert.match(JSON.stringify(adapted[3]), /tool-call-id=\\?"call-a/)
    assert.match(JSON.stringify(adapted[3]), /tool-call-id=\\?"call-b/)
    assert.doesNotThrow(() => adapted.forEach((message) => modelMessageSchema.parse(message)))

    // 请求投影不得反向改写可持久化的规范历史。
    assert.equal(toolImageCount(canonical), 2)
    assert.equal(canonical.some((message) => message.role === 'user'), false)
  })

  it('OpenAI Responses 移除供应商执行工具及其伪本地孤立结果', () => {
    const canonical = providerExecutedHistory()
    for (const normalized of [
      normalizeResponseMessagesForProvider(canonical, 'openai-responses'),
      adaptMessagesForProvider(canonical, 'openai-responses'),
    ]) {
      const serialized = JSON.stringify(normalized)
      assert.doesNotMatch(serialized, /ig_fixture|image_generation|PROVIDER_IMAGE_BYTES/)
      assert.match(serialized, /call-local|WriteFile|已写入/)
      assert.doesNotThrow(() => normalized.forEach((message) =>
        modelMessageSchema.parse(message)))
    }

    // 规范化只产生请求/提交副本，不反向修改调用方持有的原始响应。
    assert.match(JSON.stringify(canonical), /PROVIDER_IMAGE_BYTES/)
  })
})

function providerExecutedHistory(): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'ig_fixture',
          toolName: 'image_generation',
          input: {},
          providerExecuted: true,
        },
        {
          type: 'tool-result',
          toolCallId: 'ig_fixture',
          toolName: 'image_generation',
          output: { type: 'json', value: { result: 'PROVIDER_IMAGE_BYTES' } },
        },
        {
          type: 'tool-call',
          toolCallId: 'call-local',
          toolName: 'WriteFile',
          input: { path: 'builder.js' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'ig_fixture',
          toolName: 'image_generation',
          output: { type: 'error-text', value: 'AI_NoSuchToolError' },
        },
        {
          type: 'tool-result',
          toolCallId: 'call-local',
          toolName: 'WriteFile',
          output: { type: 'text', value: '已写入' },
        },
      ],
    },
  ]
}

function history(): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'call-a', toolName: 'ViewImage', input: {} },
        { type: 'tool-call', toolCallId: 'call-b', toolName: 'CaptureScreenshot', input: {} },
      ],
    },
    toolMessage('call-a', 'ViewImage', 'a.png'),
    toolMessage('call-b', 'CaptureScreenshot', 'b.png'),
    { role: 'assistant', content: '两张图片都已查看。' },
  ]
}

function toolMessage(toolCallId: string, toolName: string, filename: string): ModelMessage {
  return {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId,
      toolName,
      output: {
        type: 'content',
        value: [
          { type: 'text', text: `${toolName} 完成。` },
          {
            type: 'file',
            data: { type: 'data', data: `iVBORw0KGgo-${toolCallId}` },
            filename,
            mediaType: 'image/png',
          },
        ],
      },
    }],
  }
}

function toolImageCount(messages: readonly ModelMessage[]): number {
  let count = 0
  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const part of message.content) {
      if (part.type !== 'tool-result' || part.output.type !== 'content') continue
      count += part.output.value.filter((item) =>
        item.type === 'file' && item.mediaType.startsWith('image/')).length
    }
  }
  return count
}
