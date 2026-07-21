import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import {
  CAPTURE_SCREENSHOT_TOOL_NAME,
  createScreenshotCaptureRequestSchema,
} from '../tools/capture-screenshot/index.ts'
import { AgentSession } from './session.ts'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

describe('CaptureScreenshot Agent 链路', () => {
  it('以 target 为准规范化兼容提供商补齐的无关可选字段', () => {
    const schema = createScreenshotCaptureRequestSchema(false)
    const region = { x: 0, y: 0, width: 1920, height: 1080 }

    assert.deepEqual(schema.parse({
      target: 'screen',
      display_id: 'primary',
      window_title: 'WhyCode',
      region,
      detail: 'high',
    }), {
      target: 'screen',
      display_id: 'primary',
      detail: 'high',
    })
    assert.deepEqual(schema.parse({
      target: 'window',
      display_id: 'primary',
      window_title: 'WhyCode',
      region,
      detail: 'high',
    }), {
      target: 'window',
      window_title: 'WhyCode',
      detail: 'high',
    })
    assert.deepEqual(schema.parse({
      target: 'region',
      display_id: 'primary',
      window_title: 'WhyCode',
      region,
      detail: 'high',
    }), {
      target: 'region',
      display_id: 'primary',
      region,
      detail: 'high',
    })
    assert.throws(() => schema.parse({ target: 'region', detail: 'high' }), /region/)
  })

  it('纯聊天视觉 Main 可截图，首次隐私审批记住后形成截图—再截图闭环', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-capture-screen-'))
    try {
      const store = new SessionStore(root)
      const journal = await store.create({ projectDir: null, modelId: 'test:vision' })
      let call = 0
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          call++
          const screenshotTool = (options.tools ?? []).find((tool) =>
            tool.type === 'function' && tool.name === CAPTURE_SCREENSHOT_TOOL_NAME)
          assert.ok(screenshotTool?.type === 'function')
          assert.match(screenshotTool.description ?? '', /先截图建立基线.*修改.*再截图验证/)
          assert.match(screenshotTool.description ?? '', /单个外部应用.*window_title/)
          assert.match(screenshotTool.description ?? '', /screen\/region.*排除 WhyCode/)
          if (call === 1) return toolStep({ target: 'screen' })
          assert.equal(JSON.stringify(options.prompt).includes(ONE_PIXEL_PNG.toString('base64')), true)
          if (call === 2) {
            return toolStep({
              target: 'region',
              region: { x: 10, y: 20, width: 300, height: 200 },
            }, 'capture-2')
          }
          return finalStep('已用修改后的第二张截图完成视觉验证。')
        },
      })
      const events: CoreEvent[] = []
      const capturedTargets: string[] = []
      let approvals = 0
      const session = new AgentSession({
        model: modelEntry(model),
        providerConfig: { apiKey: 'test' },
        promptContext: { projectDir: null, osPlatform: 'win32' },
        sessionRecorder: journal,
        captureScreenshot: async (request) => {
          capturedTargets.push(request.target)
          return {
            name: `${request.target}.png`,
            bytes: ONE_PIXEL_PNG,
            description: `已截取 ${request.target}`,
          }
        },
        emit: (event) => events.push(event),
        requestApproval: async (request) => {
          approvals++
          assert.equal(request.toolName, CAPTURE_SCREENSHOT_TOOL_NAME)
          assert.match(request.reason, /敏感内容/)
          return { approved: true, remember: true }
        },
      })

      assert.equal(await session.handleUserMessage('先看界面，修改后再截图验证'), 'completed')
      assert.deepEqual(capturedTargets, ['screen', 'region'])
      assert.equal(approvals, 1)
      assert.equal(events.filter((event) => event.type === 'image-viewed').length, 2)
      const reopened = await store.open(journal.sessionId)
      assert.equal(reopened.initialImageAttachments.length, 2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('全自动档直接截图，不弹隐私审批或切走目标窗口', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-capture-screen-auto-'))
    try {
      const store = new SessionStore(root)
      const journal = await store.create({ projectDir: null, modelId: 'test:vision' })
      let call = 0
      const model = new MockLanguageModelV4({
        doStream: async () => {
          call++
          return call === 1
            ? toolStep({ target: 'screen' })
            : finalStep('已看到目标界面。')
        },
      })
      const events: CoreEvent[] = []
      let captures = 0
      const session = new AgentSession({
        model: modelEntry(model),
        providerConfig: { apiKey: 'test' },
        promptContext: { projectDir: null, osPlatform: 'win32' },
        sessionRecorder: journal,
        captureScreenshot: async () => {
          captures++
          return {
            name: 'screen.png',
            bytes: ONE_PIXEL_PNG,
            description: '已截取目标界面',
          }
        },
        emit: (event) => events.push(event),
        requestApproval: async () => {
          throw new Error('全自动档不应请求首次截图审批')
        },
      })
      session.setPermissionMode('auto')

      assert.equal(await session.handleUserMessage('直接截图查看当前界面'), 'completed')
      assert.equal(captures, 1)
      assert.equal(
        events.some((event) => event.type === 'agent-status' && event.status === 'waiting-approval'),
        false,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('兼容提供商补齐截图参数时只执行一次规范化后的工具调用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-capture-screen-normalize-'))
    try {
      const store = new SessionStore(root)
      const journal = await store.create({ projectDir: null, modelId: 'test:vision' })
      let call = 0
      const model = new MockLanguageModelV4({
        doStream: async () => {
          call++
          return call === 1
            ? toolStep({
                target: 'screen',
                detail: 'high',
                display_id: 'primary',
                window_title: 'WhyCode',
                region: { x: 0, y: 0, width: 1920, height: 1080 },
              })
            : finalStep('已看见当前屏幕。')
        },
      })
      let captures = 0
      const session = new AgentSession({
        model: modelEntry(model),
        providerConfig: { apiKey: 'test' },
        promptContext: { projectDir: null, osPlatform: 'win32' },
        sessionRecorder: journal,
        captureScreenshot: async (request) => {
          captures++
          assert.deepEqual(request, {
            target: 'screen',
            detail: 'high',
            display_id: 'primary',
          })
          return {
            name: 'screen.png',
            bytes: ONE_PIXEL_PNG,
            description: '已截取当前屏幕',
          }
        },
        emit: () => {},
        requestApproval: async () => {
          throw new Error('全自动档不应请求截图审批')
        },
      })
      session.setPermissionMode('auto')

      assert.equal(await session.handleUserMessage('看看当前屏幕'), 'completed')
      assert.equal(captures, 1)
      assert.equal(call, 2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('OpenAI Chat 只在请求副本投影工具图片，规范历史仍绑定工具结果', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-capture-screen-chat-'))
    try {
      const journal = await new SessionStore(root).create({
        projectDir: null,
        modelId: 'test:chat-vision',
      })
      let call = 0
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          call++
          if (call === 1) return toolStep({ target: 'screen' })
          const toolIndex = options.prompt.findIndex((message) => message.role === 'tool')
          assert.ok(toolIndex >= 0)
          const toolMessage = options.prompt[toolIndex]!
          assert.equal(toolMessage.role, 'tool')
          const toolResult = toolMessage.role === 'tool'
            ? toolMessage.content.find((part) => part.type === 'tool-result')
            : undefined
          assert.equal(toolResult?.type === 'tool-result' ? toolResult.output.type : '', 'text')
          const companion = options.prompt[toolIndex + 1]
          assert.equal(companion?.role, 'user')
          assert.equal(JSON.stringify(companion).includes(ONE_PIXEL_PNG.toString('base64')), true)
          return finalStep('Chat 兼容路径已看到截图。')
        },
      })
      const session = new AgentSession({
        model: modelEntry(model, true, 'openai-chat'),
        providerConfig: { apiKey: 'test' },
        promptContext: { projectDir: null, osPlatform: 'win32' },
        sessionRecorder: journal,
        captureScreenshot: async () => ({
          name: 'screen.png',
          bytes: ONE_PIXEL_PNG,
          description: '已截取屏幕',
        }),
        emit: () => {},
        requestApproval: async () => ({ approved: false }),
      })
      session.setPermissionMode('auto')

      assert.equal(await session.handleUserMessage('查看屏幕'), 'completed')
      const snapshot = session.captureMessageSnapshot()
      assert.equal(
        snapshot.some((message) =>
          message.role === 'user'
          && JSON.stringify(message).includes('whycode-attachment-ref:v1:')),
        false,
      )
      assert.match(JSON.stringify(snapshot), /whycode-attachment-ref:v1:/)
      const toolMessage = snapshot.find((message) => message.role === 'tool')
      assert.match(JSON.stringify(toolMessage), /"type":"content"/)

      assert.equal(await session.handleUserMessage('继续根据刚才的截图回答'), 'completed')
      const continued = session.captureMessageSnapshot()
      assert.equal(
        continued.some((message) =>
          message.role === 'user'
          && JSON.stringify(message).includes('whycode-attachment-ref:v1:')),
        false,
      )
      assert.match(JSON.stringify(continued), /whycode-attachment-ref:v1:/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('文字模型和讨论角色都不获得桌面截图能力', async () => {
    for (const setup of [
      { vision: false, discussion: false },
      { vision: true, discussion: true },
    ]) {
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          assert.equal(toolNames(options).includes(CAPTURE_SCREENSHOT_TOOL_NAME), false)
          return finalStep('没有截图工具。')
        },
      })
      const session = new AgentSession({
        model: modelEntry(model, setup.vision),
        providerConfig: { apiKey: 'test' },
        promptContext: {
          projectDir: null,
          osPlatform: 'win32',
          ...(setup.discussion
            ? { discussion: { agentId: 'B' as const, scratchDir: process.cwd() } }
            : {}),
        },
        captureScreenshot: async () => {
          throw new Error('不应调用')
        },
        emit: () => {},
        requestApproval: async () => ({ approved: false }),
      })
      assert.equal(await session.handleUserMessage('截图'), 'completed')
    }
  })
})

function modelEntry(
  model: MockLanguageModelV4,
  vision = true,
  protocol: ModelEntry['protocol'] = 'openai-responses',
): ModelEntry {
  return {
    id: vision ? 'test:vision' : 'test:text',
    displayName: 'Screenshot Mock',
    provider: 'openai',
    protocol,
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

function toolStep(input: unknown, toolCallId = 'capture-1') {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId,
          toolName: CAPTURE_SCREENSHOT_TOOL_NAME,
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
