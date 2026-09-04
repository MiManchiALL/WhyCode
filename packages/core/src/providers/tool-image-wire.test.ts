import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText, modelMessageSchema, type LanguageModel, type ModelMessage } from 'ai'
import { z } from 'zod'
import { adaptMessagesForProvider } from './message-adapter.ts'
import { getModelEntry } from './registry.ts'

describe('Provider 多模态工具结果线格式', () => {
  it('Anthropic Messages 把图片放进同一 tool_result', async () => {
    const body = await captureRequest(
      (baseURL) => createAnthropic({ apiKey: 'test', baseURL })('claude-test'),
      canonicalHistory(),
    )
    const result = records(body.messages)
      .flatMap((message) => records(message.content))
      .find((part: Record<string, unknown>) => part.type === 'tool_result')
    assert.ok(result)
    assert.equal(result.tool_use_id, 'call-image')
    assert.equal(records(result.content).some((part) =>
      part.type === 'image' && record(part.source)?.type === 'base64'), true)
  })

  it('OpenAI Responses 把图片放进同一 function_call_output', async () => {
    const body = await captureRequest(
      (baseURL) => createOpenAI({ apiKey: 'test', baseURL }).responses('gpt-test'),
      canonicalHistory(),
    )
    const result = records(body.input).find((item) =>
      item.type === 'function_call_output')
    assert.ok(result)
    assert.equal(result.call_id, 'call-image')
    assert.equal(records(result.output).some((part) =>
      part.type === 'input_image' && String(part.image_url).startsWith('data:image/png;base64,')), true)
  })

  it('OpenAI Chat 保留文本 tool 消息，并在其后投影关联图片', async () => {
    const messages = adaptMessagesForProvider(canonicalHistory(), 'openai-chat')
    const body = await captureRequest(
      (baseURL) => createOpenAICompatible({
        name: 'chat-test',
        apiKey: 'test',
        baseURL,
      })('chat-test'),
      messages,
    )
    const wireMessages = records(body.messages)
    const toolIndex = wireMessages.findIndex((message) =>
      message.role === 'tool')
    assert.ok(toolIndex >= 0)
    assert.equal(typeof wireMessages[toolIndex]!.content, 'string')
    assert.equal(wireMessages[toolIndex]!.tool_call_id, 'call-image')
    const companion = wireMessages[toolIndex + 1]!
    assert.equal(companion.role, 'user')
    assert.equal(records(companion.content).some((part) =>
      part.type === 'image_url'
      && String(record(part.image_url)?.url).startsWith('data:image/png;base64,')), true)
  })

  it('DeepSeek 视觉模型在工具轮回传图片和完整推理，跨新用户消息仍保留', async () => {
    const history = canonicalHistory()
    const assistant = history[0]!
    assert.ok(assistant.role === 'assistant' && Array.isArray(assistant.content))
    assistant.content.unshift({ type: 'reasoning', text: '先查看截图。' })
    history.push({ role: 'assistant', content: '已查看。' })
    history.push({ role: 'user', content: '继续分析。' })
    const restored = z.array(modelMessageSchema).parse(JSON.parse(JSON.stringify(history)))
    const entry = getModelEntry('deepseek:deepseek-v4-flash-vision-exp')
    const body = await captureRequest(
      (baseURL) => entry.create({ apiKey: 'test', baseURL }),
      adaptMessagesForProvider(restored, entry.protocol),
    )
    assert.equal(body.model, 'deepseek-v4-flash-vision-exp')
    const messages = records(body.messages)
    const assistants = messages.filter((message) => message.role === 'assistant')
    assert.equal(assistants[0]?.reasoning_content, '先查看截图。')
    assert.equal(assistants[1]?.reasoning_content, '')
    const images = messages.filter((message) => message.role === 'user')
      .flatMap((message) => records(message.content))
      .filter((part) => part.type === 'image_url')
    assert.equal(images.length, 1)
    assert.equal(record(images[0]?.image_url)?.url, 'data:image/png;base64,aGVsbG8=')
    assert.equal(messages.find((message) => message.role === 'tool')?.tool_call_id, 'call-image')
  })
})

async function captureRequest(
  createModel: (baseURL: string) => LanguageModel,
  messages: ModelMessage[],
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | null = null
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    body = JSON.parse(raw) as Record<string, unknown>
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'request captured', type: 'test' } }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address() as AddressInfo
    await assert.rejects(generateText({
      model: createModel(`http://127.0.0.1:${address.port}/v1`),
      messages,
      tools: { ViewImage: { inputSchema: z.object({ path: z.string() }) } },
      maxRetries: 0,
    }))
    assert.ok(body)
    return body
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  const output: Record<string, unknown>[] = []
  for (const item of value) {
    const parsed = record(item)
    if (parsed) output.push(parsed)
  }
  return output
}

function canonicalHistory(): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'call-image',
        toolName: 'ViewImage',
        input: { path: 'screen.png' },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-image',
        toolName: 'ViewImage',
        output: {
          type: 'content',
          value: [
            { type: 'text', text: '已读取图片。' },
            {
              type: 'file',
              data: { type: 'data', data: 'aGVsbG8=' },
              filename: 'screen.png',
              mediaType: 'image/png',
            },
          ],
        },
      }],
    },
  ]
}
