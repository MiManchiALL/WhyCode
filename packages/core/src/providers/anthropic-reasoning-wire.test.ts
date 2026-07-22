import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { it } from 'node:test'
import { generateText } from 'ai'
import { getModelEntry } from './registry.ts'
import { providerOptionsWithReasoningEffort } from './reasoning-effort.ts'

it('Anthropic 把会话档位写入 adaptive thinking 的 output_config.effort', async () => {
  let body: Record<string, unknown> | null = null
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    body = JSON.parse(raw) as Record<string, unknown>
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'request captured' },
    }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  try {
    const address = server.address() as AddressInfo
    const entry = getModelEntry('anthropic:claude-sonnet-4-6')
    await assert.rejects(generateText({
      model: entry.create({
        apiKey: 'test',
        baseURL: `http://127.0.0.1:${address.port}`,
      }),
      prompt: 'hello',
      providerOptions: providerOptionsWithReasoningEffort(entry, 'max'),
      maxRetries: 0,
    }))
    const captured = body as Record<string, unknown> | null
    assert.ok(captured)
    assert.deepEqual(captured.thinking, { type: 'adaptive' })
    assert.deepEqual(captured.output_config, { effort: 'max' })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})
