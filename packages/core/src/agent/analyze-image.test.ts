import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { importImageAttachments } from '../attachments/storage.ts'
import type { AuxiliaryImageAnalyzer } from '../auxiliary/image-analysis.ts'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import { ANALYZE_IMAGE_TOOL_NAME } from '../tools/analyze-image/index.ts'
import { localWorkspace } from '../workspace/types.ts'
import { AgentSession } from './session.ts'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

describe('辅助识图 Agent 链路', () => {
  it('非视觉 Main 只收到稳定引用，按上下文问题调用辅助模型并保留文字结果', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-analyze-image-'))
    try {
      const journal = await new SessionStore(join(root, 'sessions')).create({
        workspace: localWorkspace(null),
        modelId: 'test:text',
      })
      const source = join(root, 'blue-circle.png')
      await writeFile(source, ONE_PIXEL_PNG)
      const attachments = await importImageAttachments(
        [{ kind: 'path', path: source }],
        journal.attachmentDirectory,
        journal.sessionId,
      )
      const calls: Array<{ question: string; attachmentIds: string[] }> = []
      const analyzer: AuxiliaryImageAnalyzer = {
        modelId: 'test:vision-helper',
        modelDisplayName: 'Vision Helper',
        async analyze(request) {
          calls.push({
            question: request.question,
            attachmentIds: request.attachments.map((attachment) => attachment.id),
          })
          return '蓝色圆圈内是一个白色字母 A。'
        },
      }
      const mainModel = new MockLanguageModelV4({
        doStream: [
          toolStep({
            attachmentIds: [attachments[0]!.id],
            question: '重点查看图片蓝色圆圈区域，并识别其中的对象。',
          }),
          finalStep('蓝圈里是白色字母 A。'),
        ],
      })
      const events: CoreEvent[] = []
      const session = new AgentSession({
        model: modelEntry(mainModel, false),
        providerConfig: { apiKey: 'main' },
        promptContext: { projectDir: null, osPlatform: 'win32' },
        sessionRecorder: journal,
        auxiliaryImageAnalyzer: analyzer,
        emit: (event) => events.push(event),
        requestApproval: async () => ({ approved: true }),
      })
      const inputId = randomUUID()
      await journal.recordUserInputWithId(
        inputId,
        '之前的问题是：蓝圈里是什么？',
        true,
        attachments,
        [],
        [],
        [],
        'auxiliary',
      )
      assert.equal(await session.handleUserMessage(
        '之前的问题是：蓝圈里是什么？',
        false,
        attachments,
        inputId,
        [],
        [],
        'auxiliary',
      ), 'completed')

      const firstCall = mainModel.doStreamCalls[0]!
      assert.equal(toolNames(firstCall).includes(ANALYZE_IMAGE_TOOL_NAME), true)
      const firstPrompt = JSON.stringify(firstCall.prompt)
      assert.match(firstPrompt, new RegExp(attachments[0]!.id))
      assert.match(firstPrompt, /像素需调用 AnalyzeImage/)
      assert.doesNotMatch(firstPrompt, /whycode-attachment-ref/)
      assert.deepEqual(calls, [{
        question: '重点查看图片蓝色圆圈区域，并识别其中的对象。',
        attachmentIds: [attachments[0]!.id],
      }])
      assert.match(JSON.stringify(mainModel.doStreamCalls[1]!.prompt), /蓝色圆圈内是一个白色字母 A/)
      assert.equal(events.some((event) =>
        event.type === 'tool-end' && event.isError), false)

      const visualModel = new MockLanguageModelV4({
        doStream: async (options) => {
          assert.equal(toolNames(options).includes(ANALYZE_IMAGE_TOOL_NAME), false)
          const prompt = JSON.stringify(options.prompt)
          assert.match(prompt, /蓝色圆圈内是一个白色字母 A/)
          assert.doesNotMatch(prompt, /whycode-attachment-ref|iVBORw0KGgo/)
          return finalStep('继续。')
        },
      })
      await session.setModelSelection(modelEntry(visualModel, true), { apiKey: 'visual' }, 'default')
      assert.equal(await session.handleUserMessage('继续'), 'completed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function modelEntry(model: MockLanguageModelV4, vision: boolean): ModelEntry {
  return {
    id: vision ? 'test:vision' : 'test:text',
    displayName: vision ? 'Vision' : 'Text',
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
    create: () => model,
  }
}

function toolStep(input: unknown) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: 'analyze-1',
          toolName: ANALYZE_IMAGE_TOOL_NAME,
          input: JSON.stringify(input),
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: usage(),
        },
      ],
    }),
  }
}

function finalStep(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'final' },
        { type: 'text-delta' as const, id: 'final', delta: text },
        { type: 'text-end' as const, id: 'final' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(),
        },
      ],
    }),
  }
}

function toolNames(call: MockLanguageModelV4['doStreamCalls'][number]): string[] {
  return (call.tools ?? []).flatMap((tool) => tool.type === 'function' ? [tool.name] : [])
}

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
}
