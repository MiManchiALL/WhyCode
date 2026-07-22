import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { generateText } from 'ai'
import type { ReasoningEffortSelection } from './catalog.ts'
import { providerOptionsWithReasoningEffort } from './reasoning-effort.ts'
import { getModelEntry } from './registry.ts'

describe('受控连接路由与推理线格式', () => {
  it('Anthropic Messages 同时使用覆盖路由与 adaptive effort', async () => {
    const captured = await captureRequest(
      'anthropic:claude-sonnet-4-6',
      'proxy-claude-route',
      'max',
    )
    assert.equal(captured.path, '/v1/messages')
    assert.equal(captured.body.model, 'proxy-claude-route')
    assert.deepEqual(captured.body.thinking, { type: 'adaptive' })
    assert.deepEqual(captured.body.output_config, { effort: 'max' })
  })

  it('OpenAI Chat 同时使用覆盖路由与 reasoning_effort', async () => {
    const captured = await captureRequest(
      'google:gemini-3.1-pro-preview',
      'proxy-gemini-route',
      'medium',
    )
    assert.equal(captured.path, '/v1/chat/completions')
    assert.equal(captured.body.model, 'proxy-gemini-route')
    assert.equal(captured.body.reasoning_effort, 'medium')
  })

  it('OpenAI Responses 同时使用覆盖路由与 reasoning.effort', async () => {
    const captured = await captureRequest(
      'openai:gpt-5.6-sol',
      'proxy-gpt-route',
      'xhigh',
    )
    assert.equal(captured.path, '/v1/responses')
    assert.equal(captured.body.model, 'proxy-gpt-route')
    assert.deepEqual(captured.body.reasoning, {
      effort: 'xhigh',
      summary: 'auto',
    })
    assert.equal(captured.body.store, false)
  })
})

async function captureRequest(
  profileId: string,
  routeModelId: string,
  reasoningEffort: ReasoningEffortSelection,
): Promise<{ path: string; body: Record<string, unknown> }> {
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
    const entry = getModelEntry(profileId)
    await assert.rejects(generateText({
      model: entry.create(
        {
          apiKey: 'test-key',
          baseURL: `http://127.0.0.1:${address.port}/v1`,
        },
        routeModelId,
      ),
      prompt: 'hello',
      providerOptions: providerOptionsWithReasoningEffort(entry, reasoningEffort),
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
