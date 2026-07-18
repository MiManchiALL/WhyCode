import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { generateText, Output, type ModelMessage } from 'ai'
import { z } from 'zod'
import { getModelEntry } from './registry.ts'

describe('Google OpenAI 兼容线格式', () => {
  it('保留思考参数、JSON Schema 与 Gemini thought signature', async () => {
    const captured = await captureGeminiRequest()

    assert.equal(captured.path, '/v1/chat/completions')
    assert.equal(captured.body.model, 'gemini-3.5-flash')
    assert.deepEqual(captured.body.extra_body, {
      google: { thinking_config: { include_thoughts: true } },
    })
    assert.equal(record(captured.body.response_format)?.type, 'json_schema')

    const assistant = records(captured.body.messages)
      .find((message) => message.role === 'assistant')
    const toolCall = records(assistant?.tool_calls)[0]
    const google = record(record(toolCall?.extra_content)?.google)
    assert.equal(google?.thought_signature, 'thought-signature-1')
  })
})

async function captureGeminiRequest(): Promise<{
  path: string
  body: Record<string, unknown>
}> {
  let path = ''
  let body: Record<string, unknown> | null = null
  const server = createServer(async (request, response) => {
    path = request.url ?? ''
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
    const entry = getModelEntry('google:gemini-3.5-flash')
    await assert.rejects(generateText({
      model: entry.create({
        apiKey: 'test-key',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
      }),
      messages: signedToolHistory(),
      output: Output.object({ schema: z.object({ ok: z.boolean() }) }),
      providerOptions: entry.providerOptions,
      maxRetries: 0,
    }))
    assert.ok(body)
    return { path, body }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}

function signedToolHistory(): ModelMessage[] {
  return [
    {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'ReadFile',
        input: { path: 'README.md' },
        providerOptions: { google: { thoughtSignature: 'thought-signature-1' } },
      }],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'ReadFile',
        output: { type: 'text', value: 'file contents' },
      }],
    },
    { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
  ]
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
