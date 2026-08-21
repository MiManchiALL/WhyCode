import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { MockLanguageModelV4 } from 'ai/test'
import { importImageAttachments } from '../attachments/storage.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { createAuxiliaryImageAnalyzer } from './image-analysis.ts'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

describe('辅助识图模型边界', () => {
  it('只发送改写后的问题与选中图片，不携带主会话历史或工具', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-aux-vision-'))
    try {
      const imagePath = join(root, 'sample.png')
      await writeFile(imagePath, ONE_PIXEL_PNG)
      const sessionId = '11111111-1111-4111-8111-111111111111'
      const attachments = await importImageAttachments(
        [{ kind: 'path', path: imagePath }],
        root,
        sessionId,
      )
      const model = new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [{ type: 'text', text: '观察结果' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: usage(),
          warnings: [],
        }),
      })
      let transportSessionId = ''
      const analyzer = createAuxiliaryImageAnalyzer({
        model: modelEntry(model, true, (id) => { transportSessionId = id ?? '' }),
        providerConfig: { apiKey: 'helper-secret' },
      })
      assert.equal(await analyzer.analyze({
        question: '只读取左上角蓝色区域。',
        attachments,
        attachmentDirectory: root,
      }, new AbortController().signal), '观察结果')

      assert.equal(model.doGenerateCalls.length, 1)
      assert.match(transportSessionId, /^[0-9a-f-]{36}$/)
      const call = model.doGenerateCalls[0]!
      assert.equal(call.tools?.length ?? 0, 0)
      const prompt = JSON.stringify(call.prompt)
      assert.match(prompt, /只读取左上角蓝色区域/)
      assert.doesNotMatch(prompt, new RegExp(`${attachments[0]!.id}|sample\\.png`))
      assert.doesNotMatch(prompt, /helper-secret|主会话历史/)
      const user = call.prompt.find((message) => message.role === 'user')
      assert.equal(user?.content.some((part) => part.type === 'file'), true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('拒绝把非视觉模型装配为辅助识图模型', () => {
    const model = new MockLanguageModelV4({})
    assert.throws(
      () => createAuxiliaryImageAnalyzer({
        model: modelEntry(model, false),
        providerConfig: { apiKey: 'key' },
      }),
      /不是可用的辅助识图模型/,
    )
  })
})

function modelEntry(
  model: MockLanguageModelV4,
  vision: boolean,
  onCreate?: (transportSessionId: string | undefined) => void,
): ModelEntry {
  return {
    id: vision ? 'test:helper' : 'test:text',
    displayName: vision ? 'Helper' : 'Text',
    provider: 'openai',
    protocol: 'openai-responses',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: vision,
      reasoningExposure: 'none',
      structuredOutput: 'tool-based',
      promptCaching: 'none',
      contextWindow: 100_000,
      maxOutput: 4_000,
    },
    create: (_config, options) => {
      onCreate?.(options?.transportSessionId)
      return model
    },
  }
}

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
}
