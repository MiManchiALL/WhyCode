import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import { createViewImageTool, VIEW_IMAGE_TOOL_NAME } from '../tools/view-image/index.ts'
import { AgentSession } from './session.ts'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

describe('ViewImage Agent 链路', () => {
  it('original 只在模型能力已验证时进入工具 schema', () => {
    const base = {
      attachmentDirectory: process.cwd(),
      sessionId: '11111111-1111-4111-8111-111111111111',
    }
    const highOnly = createViewImageTool(base)
    assert.equal(
      highOnly.inputSchema.safeParse({ path: 'screen.png', detail: 'original' }).success,
      false,
    )
    const original = createViewImageTool({ ...base, supportsOriginalDetail: true })
    assert.equal(
      original.inputSchema.safeParse({
        path: 'screen.png',
        detail: 'original',
        region: { x: 10, y: 20, width: 30, height: 40 },
      }).success,
      true,
    )
  })

  it('只向视觉 Main 注册，并以稳定引用跨重启恢复', async () => {
    await withTempDirectory(async (directory) => {
      const projectDir = join(directory, 'project')
      const sessionRoot = join(directory, 'sessions')
      await writeFile(await ensureProjectImage(projectDir), ONE_PIXEL_PNG)
      const store = new SessionStore(sessionRoot)
      const journal = await store.create({ projectDir, modelId: 'test:vision' })

      let call = 0
      const visualModel = new MockLanguageModelV4({
        doStream: async (options) => {
          call++
          assert.equal(toolNames(options).includes(VIEW_IMAGE_TOOL_NAME), true)
          if (call === 1) return viewImageStep('screen.png')
          assert.equal(JSON.stringify(options.prompt).includes(ONE_PIXEL_PNG.toString('base64')), true)
          const toolMessage = options.prompt.find((message) => message.role === 'tool')
          assert.equal(toolMessage?.role, 'tool')
          const result = toolMessage?.role === 'tool'
            ? toolMessage.content.find((part) => part.type === 'tool-result')
            : undefined
          assert.equal(result?.type === 'tool-result' ? result.output.type : '', 'content')
          assert.equal(options.prompt.filter((message) => message.role === 'user').length, 1)
          return finalStep('图片已读取。')
        },
      })
      const events: CoreEvent[] = []
      const session = createSession(
        visualModel,
        journal,
        projectDir,
        true,
        (event) => events.push(event),
      )
      assert.equal(await session.handleUserMessage('请查看项目截图'), 'completed')
      const viewed = events.filter((event) => event.type === 'image-viewed')
      assert.equal(viewed.length, 1)
      assert.equal(viewed[0]?.type === 'image-viewed' ? viewed[0].attachments[0]?.name : '', 'screen.png')

      const transcript = await readFile(
        join(sessionRoot, journal.sessionId, 'transcript.jsonl'),
        'utf8',
      )
      assert.match(transcript, /whycode-attachment-ref:v1:/)
      assert.equal(transcript.includes(ONE_PIXEL_PNG.toString('base64')), false)

      const reopened = await store.open(journal.sessionId)
      assert.equal(reopened.initialImageAttachments.length, 1)
      assert.match(JSON.stringify(reopened.initialMessages), /whycode-attachment-ref:v1:/)

      const resumedVisualModel = new MockLanguageModelV4({
        doStream: async (options) => {
          assert.equal(toolNames(options).includes(VIEW_IMAGE_TOOL_NAME), true)
          assert.equal(JSON.stringify(options.prompt).includes(ONE_PIXEL_PNG.toString('base64')), true)
          return finalStep('恢复后仍可见。')
        },
      })
      assert.equal(
        await createSession(resumedVisualModel, reopened, projectDir, true)
          .handleUserMessage('还能看到刚才的图片吗？'),
        'completed',
      )

      const reopenedAgain = await store.open(journal.sessionId)
      const textModel = new MockLanguageModelV4({
        doStream: async (options) => {
          const serialized = JSON.stringify(options.prompt)
          assert.equal(toolNames(options).includes(VIEW_IMAGE_TOOL_NAME), false)
          assert.equal(serialized.includes(ONE_PIXEL_PNG.toString('base64')), false)
          assert.match(serialized, /当前模型不支持识图/)
          return finalStep('当前模型看不到图片。')
        },
      })
      assert.equal(
        await createSession(textModel, reopenedAgain, projectDir, false)
          .handleUserMessage('用文字模型继续'),
        'completed',
      )

      const afterTextTurn = await store.open(journal.sessionId)
      const visualAgain = new MockLanguageModelV4({
        doStream: async (options) => {
          assert.equal(JSON.stringify(options.prompt).includes(ONE_PIXEL_PNG.toString('base64')), true)
          return finalStep('切回视觉模型后仍可见。')
        },
      })
      assert.equal(
        await createSession(visualAgain, afterTextTurn, projectDir, true)
          .handleUserMessage('切回视觉模型继续看图'),
        'completed',
      )
    })
  })

  it('step 在工具执行后被中止时回收未提交图片', async () => {
    await withTempDirectory(async (directory) => {
      const projectDir = join(directory, 'project')
      const sessionRoot = join(directory, 'sessions')
      await writeFile(await ensureProjectImage(projectDir), ONE_PIXEL_PNG)
      const store = new SessionStore(sessionRoot)
      const journal = await store.create({ projectDir, modelId: 'test:vision' })
      const model = new MockLanguageModelV4({ doStream: [viewImageStep('screen.png')] })
      let session!: AgentSession
      session = new AgentSession({
        model: modelEntry(model, true),
        providerConfig: { apiKey: 'test' },
        promptContext: { projectDir, osPlatform: 'win32' },
        sessionRecorder: journal,
        emit: (event) => {
          if (event.type === 'tool-end') session.abort()
        },
        requestApproval: async () => ({ approved: false }),
      })

      assert.equal(await session.handleUserMessage('查看后立即停止'), 'aborted')
      assert.deepEqual(await readdir(journal.attachmentDirectory), [])
      const reopened = await store.open(journal.sessionId)
      assert.equal(reopened.initialImageAttachments.length, 0)
      assert.doesNotMatch(
        await readFile(join(sessionRoot, journal.sessionId, 'transcript.jsonl'), 'utf8'),
        /whycode-attachment-ref:v1:/,
      )
    })
  })

  it('视觉模型也不向讨论 Agent 或协议回合暴露工具', async () => {
    await withTempDirectory(async (directory) => {
      const projectDir = join(directory, 'project')
      const scratchDir = join(directory, 'scratch')
      const store = new SessionStore(join(directory, 'sessions'))
      await mkdir(projectDir, { recursive: true })

      const discussionJournal = await store.create({ projectDir, modelId: 'test:vision' })
      const discussionModel = modelWithoutViewImage()
      const discussion = new AgentSession({
        model: modelEntry(discussionModel, true),
        providerConfig: { apiKey: 'test' },
        promptContext: {
          projectDir,
          osPlatform: 'win32',
          discussion: { agentId: 'B', scratchDir },
        },
        sessionRecorder: discussionJournal,
        emit: () => {},
        requestApproval: async () => ({ approved: false }),
      })
      assert.equal(await discussion.handleUserMessage('讨论图片'), 'completed')

      const protocolJournal = await store.create({ projectDir, modelId: 'test:vision' })
      const protocolModel = modelWithoutViewImage()
      const protocol = createSession(protocolModel, protocolJournal, projectDir, true)
      protocol.setProtocolRound(true)
      assert.equal(await protocol.handleUserMessage('协议回合'), 'completed')
    })
  })
})

function createSession(
  model: MockLanguageModelV4,
  recorder: Awaited<ReturnType<SessionStore['create']>>,
  projectDir: string,
  supportsImageInput: boolean,
  emit: (event: CoreEvent) => void = () => {},
): AgentSession {
  return new AgentSession({
    model: modelEntry(model, supportsImageInput),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir, osPlatform: 'win32' },
    sessionRecorder: recorder,
    emit,
    requestApproval: async () => ({ approved: false }),
  })
}

function modelEntry(model: MockLanguageModelV4, supportsImageInput: boolean): ModelEntry {
  return {
    id: supportsImageInput ? 'test:vision' : 'test:text',
    displayName: 'ViewImage Mock',
    provider: 'openai',
    protocol: 'openai-responses',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput,
      reasoningExposure: 'none',
      structuredOutput: 'tool-based',
      promptCaching: 'none',
      contextWindow: 100_000,
      maxOutput: 4_000,
    },
    create: () => model,
  }
}

function viewImageStep(path: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: 'view-image-1',
          toolName: VIEW_IMAGE_TOOL_NAME,
          input: JSON.stringify({ path }),
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

function modelWithoutViewImage(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      assert.equal(toolNames(options).includes(VIEW_IMAGE_TOOL_NAME), false)
      return finalStep('当前角色不提供图片工具。')
    },
  })
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

async function ensureProjectImage(projectDir: string): Promise<string> {
  await mkdir(projectDir, { recursive: true })
  return join(projectDir, 'screen.png')
}

async function withTempDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'whycode-view-image-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
