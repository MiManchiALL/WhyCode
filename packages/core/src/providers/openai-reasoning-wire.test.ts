import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import {
  generateText,
  modelMessageSchema,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ProviderMetadata,
} from 'ai'
import { z } from 'zod'
import type { ReasoningEffortSelection } from './catalog.ts'
import { providerOptionsWithReasoningEffort } from './reasoning-effort.ts'
import type { ModelEntry } from './registry.ts'
import { getModelEntry } from './registry.ts'

describe('OpenAI Responses 推理摘要线格式', () => {
  it('内置 GPT 默认只请求摘要，不覆盖厂商默认推理强度', async () => {
    const captured = await captureRequest(getModelEntry('openai:gpt-5.6-sol'))

    assert.equal(captured.path, '/v1/responses')
    assert.equal(captured.body.model, 'gpt-5.6-sol')
    assert.deepEqual(captured.body.reasoning, {
      summary: 'auto',
    })
    assert.equal(captured.body.store, false)
    assert.equal(
      records(captured.body.include).includes('reasoning.encrypted_content'),
      true,
    )
  })

  it('内置 GPT 把会话显式选档写入 Responses reasoning.effort', async () => {
    const captured = await captureRequest(
      getModelEntry('openai:gpt-5.6-sol'),
      undefined,
      'max',
    )
    assert.deepEqual(captured.body.reasoning, {
      effort: 'max',
      summary: 'auto',
    })
  })

  it('无服务端存储时重放完整 encrypted reasoning，不发送失效 item 引用', async () => {
    const entry = getModelEntry('openai:gpt-5.6-sol')
    const messages: ModelMessage[] = [
      { role: 'user', content: '先读取 PDF，再回答。' },
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: '规划完整读取。',
            providerOptions: {
              openai: {
                itemId: 'rs_fixture',
                reasoningEncryptedContent: 'encrypted-fixture',
              },
            },
          },
          {
            type: 'tool-call',
            toolCallId: 'call_fixture',
            toolName: 'ReadPdf',
            input: { sourceType: 'attachment', sourceValue: 'pdf-1' },
            providerOptions: { openai: { itemId: 'fc_fixture' } },
          },
        ],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'call_fixture',
          toolName: 'ReadPdf',
          output: { type: 'text', value: 'PDF contents' },
        }],
      },
    ]
    const restoredMessages = z.array(modelMessageSchema).parse(
      JSON.parse(JSON.stringify(messages)),
    )
    const captured = await captureRequest(
      entry,
      (model, providerOptions) => generateText({
        model,
        messages: restoredMessages,
        tools: {
          ReadPdf: tool({
            description: '读取 PDF',
            inputSchema: z.object({
              sourceType: z.string(),
              sourceValue: z.string(),
            }),
          }),
        },
        providerOptions,
        maxRetries: 0,
      }),
    )

    const input = objectRecords(captured.body.input)
    const reasoning = input.find((item) => item.type === 'reasoning')
    assert.deepEqual(reasoning, {
      type: 'reasoning',
      id: 'rs_fixture',
      encrypted_content: 'encrypted-fixture',
      summary: [{ type: 'summary_text', text: '规划完整读取。' }],
    })
    assert.equal(
      input.some((item) => item.type === 'item_reference' && item.id === 'rs_fixture'),
      false,
    )
  })
})

type RequestInvoker = (
  model: LanguageModel,
  providerOptions: ProviderMetadata | undefined,
) => Promise<unknown>

async function captureRequest(entry: ModelEntry): Promise<{
  path: string
  body: Record<string, unknown>
}>
async function captureRequest(
  entry: ModelEntry,
  invoke: RequestInvoker,
): Promise<{ path: string; body: Record<string, unknown> }>
async function captureRequest(
  entry: ModelEntry,
  invoke: RequestInvoker | undefined,
  reasoningEffort: ReasoningEffortSelection,
): Promise<{ path: string; body: Record<string, unknown> }>
async function captureRequest(
  entry: ModelEntry,
  invoke?: RequestInvoker,
  reasoningEffort?: ReasoningEffortSelection,
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
    const selection = reasoningEffort ?? 'default'
    const model = entry.create({
      apiKey: 'test-key',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    })
    const providerOptions = providerOptionsWithReasoningEffort(entry, selection)
    await assert.rejects(invoke
      ? invoke(model, providerOptions)
      : generateText({
          model,
          prompt: 'Explain the tradeoff.',
          providerOptions,
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

function records(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function objectRecords(value: unknown): Record<string, unknown>[] {
  return records(value).filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
  )
}
