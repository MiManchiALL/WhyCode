import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import {
  modelMessageSchema,
  stepCountIs,
  streamText,
  tool,
  type ModelMessage,
} from 'ai'
import { z } from 'zod'
import { getModelEntry } from './registry.ts'

interface MimoRequestBody {
  thinking?: { type?: unknown }
  messages?: Array<{
    role?: string
    reasoning_content?: unknown
    tool_calls?: unknown
  }>
}

describe('MiMo thinking 工具历史', () => {
  it('流式展示 reasoning，并在外层下一步骤逐字回传 reasoning_content', async () => {
    const requests: MimoRequestBody[] = []
    let serverError: unknown = null
    const server = createServer(async (request, response) => {
      try {
        requests.push(await readRequestBody(request))
        if (requests.length === 1) {
          sendFirstToolCall(response)
        } else if (requests.length === 2) {
          sendFinalAnswer(response)
        } else if (requests.length === 3) {
          sendFollowupAnswer(response)
        } else {
          response.writeHead(500).end('unexpected request')
        }
      } catch (error) {
        serverError = error
        response.writeHead(500).end('fixture error')
      }
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    try {
      const address = server.address() as AddressInfo
      const modelEntry = getModelEntry('mimo:mimo-v2.5')
      const modelConfig = {
        apiKey: 'test-key',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
      }
      const tools = {
        get_value: tool({
          description: '返回测试值',
          inputSchema: z.object({}),
          execute: async () => ({ value: 42 }),
        }),
      }
      const messages: ModelMessage[] = [{ role: 'user', content: '先调用工具，再回答。' }]

      const first = streamText({
        model: modelEntry.create(modelConfig),
        messages,
        tools,
        stopWhen: stepCountIs(1),
        maxRetries: 0,
        providerOptions: modelEntry.providerOptions,
      })
      let firstStreamReasoning = ''
      for await (const part of first.fullStream) {
        if (part.type === 'reasoning-delta') firstStreamReasoning += part.text
        if (part.type === 'error') throw part.error
      }
      const firstResponse = await first.response
      const firstAssistant = firstResponse.messages.find((message) => message.role === 'assistant')
      assert.ok(firstAssistant && typeof firstAssistant.content !== 'string')
      const persistedReasoning = firstAssistant.content
        .filter((part) => part.type === 'reasoning')
        .map((part) => part.text)
        .join('')
      assert.equal(firstStreamReasoning, '先读取工具结果。')
      assert.equal(persistedReasoning, firstStreamReasoning)
      assert.equal(firstAssistant.content.some((part) => part.type === 'tool-call'), true)

      // SessionStore 使用同一个 modelMessageSchema；先走 JSON 往返，覆盖真实重启恢复边界。
      const restoredMessages = z.array(modelMessageSchema).parse(
        JSON.parse(JSON.stringify([...messages, ...firstResponse.messages])),
      )
      const second = streamText({
        model: modelEntry.create(modelConfig),
        messages: restoredMessages,
        tools,
        stopWhen: stepCountIs(1),
        maxRetries: 0,
        providerOptions: modelEntry.providerOptions,
      })
      let secondStreamReasoning = ''
      let finalText = ''
      for await (const part of second.fullStream) {
        if (part.type === 'reasoning-delta') secondStreamReasoning += part.text
        if (part.type === 'text-delta') finalText += part.text
        if (part.type === 'error') throw part.error
      }
      const secondResponse = await second.response

      const followupMessages = z.array(modelMessageSchema).parse(
        JSON.parse(JSON.stringify([
          ...restoredMessages,
          ...secondResponse.messages,
          { role: 'user', content: '这是新的用户轮次，请直接确认。' },
        ])),
      )
      const third = streamText({
        model: modelEntry.create(modelConfig),
        messages: followupMessages,
        tools,
        stopWhen: stepCountIs(1),
        maxRetries: 0,
        providerOptions: modelEntry.providerOptions,
      })
      let followupReasoning = ''
      let followupText = ''
      for await (const part of third.fullStream) {
        if (part.type === 'reasoning-delta') followupReasoning += part.text
        if (part.type === 'text-delta') followupText += part.text
        if (part.type === 'error') throw part.error
      }
      await third.response

      assert.equal(serverError, null)
      assert.equal(requests.length, 3)
      assert.deepEqual(requests.map((request) => request.thinking?.type), [
        'enabled',
        'enabled',
        'enabled',
      ])
      for (const subsequentRequest of requests.slice(1)) {
        const historicalToolCall = subsequentRequest.messages?.find((message) =>
          message.role === 'assistant' && message.tool_calls != null)
        assert.equal(historicalToolCall?.reasoning_content, persistedReasoning)
      }
      assert.equal(secondStreamReasoning, '工具结果有效。')
      assert.equal(finalText, 'MIMO_THINKING_TOOL_OK')
      assert.equal(followupReasoning, '历史工具思考仍然完整。')
      assert.equal(followupText, 'MIMO_THINKING_FOLLOWUP_OK')
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    }
  })
})

async function readRequestBody(request: IncomingMessage): Promise<MimoRequestBody> {
  let body = ''
  for await (const chunk of request) body += chunk
  return JSON.parse(body) as MimoRequestBody
}

function sendFirstToolCall(response: ServerResponse): void {
  startEventStream(response)
  sendChunk(response, {
    choices: [{ index: 0, delta: { reasoning_content: '先读取工具结果。' }, finish_reason: null }],
  })
  sendChunk(response, {
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call-get-value',
          type: 'function',
          function: { name: 'get_value', arguments: '{}' },
        }],
      },
      finish_reason: null,
    }],
  })
  sendChunk(response, {
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: usage(12, 5, 3),
  })
  endEventStream(response)
}

function sendFinalAnswer(response: ServerResponse): void {
  startEventStream(response)
  sendChunk(response, {
    choices: [{ index: 0, delta: { reasoning_content: '工具结果有效。' }, finish_reason: null }],
  })
  sendChunk(response, {
    choices: [{ index: 0, delta: { content: 'MIMO_THINKING_TOOL_OK' }, finish_reason: null }],
  })
  sendChunk(response, {
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: usage(20, 8, 3),
  })
  endEventStream(response)
}

function sendFollowupAnswer(response: ServerResponse): void {
  startEventStream(response)
  sendChunk(response, {
    choices: [{
      index: 0,
      delta: { reasoning_content: '历史工具思考仍然完整。' },
      finish_reason: null,
    }],
  })
  sendChunk(response, {
    choices: [{ index: 0, delta: { content: 'MIMO_THINKING_FOLLOWUP_OK' }, finish_reason: null }],
  })
  sendChunk(response, {
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: usage(26, 7, 3),
  })
  endEventStream(response)
}

function startEventStream(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    connection: 'close',
  })
}

function sendChunk(response: ServerResponse, value: Record<string, unknown>): void {
  response.write(`data: ${JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'mimo-v2.5',
    ...value,
  })}\n\n`)
}

function endEventStream(response: ServerResponse): void {
  response.end('data: [DONE]\n\n')
}

function usage(prompt: number, completion: number, reasoning: number) {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    completion_tokens_details: { reasoning_tokens: reasoning },
  }
}
