import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { generateText } from 'ai'
import type { ReasoningEffortSelection } from './catalog.ts'
import { providerOptionsWithReasoningEffort } from './reasoning-effort.ts'
import { getModelEntry } from './registry.ts'

describe('DeepSeek 推理强度线格式', () => {
  it('默认启用推理且不覆盖官方默认强度', async () => {
    for (const [profileId, wireModelId] of [
      ['deepseek:deepseek-v4-flash', 'deepseek-v4-flash'],
      ['deepseek:deepseek-v4-pro', 'deepseek-v4-pro'],
    ] as const) {
      const body = await captureRequest(profileId, 'default')
      assert.equal(body.model, wireModelId)
      assert.deepEqual(body.thinking, { type: 'enabled' })
      assert.equal(body.reasoning_effort, undefined)
    }
  })

  it('显式档位使用官方 reasoning_effort 字段', async () => {
    const body = await captureRequest('deepseek:deepseek-v4-pro', 'max')
    assert.equal(body.model, 'deepseek-v4-pro')
    assert.deepEqual(body.thinking, { type: 'enabled' })
    assert.equal(body.reasoning_effort, 'max')
  })
})

async function captureRequest(
  profileId: string,
  reasoningEffort: ReasoningEffortSelection,
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
    const entry = getModelEntry(profileId)
    await assert.rejects(generateText({
      model: entry.create({
        apiKey: 'test-key',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
      }),
      prompt: 'Explain the tradeoff.',
      providerOptions: providerOptionsWithReasoningEffort(entry, reasoningEffort),
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
