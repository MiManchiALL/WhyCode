import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import { isProjectInstructionsMessage } from '../instructions/project.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { parseTranscript } from '../session/chain.ts'
import { SessionStore } from '../session/store.ts'
import { buildTool } from '../tools/tool.ts'
import { AgentSession } from './session.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('Agent 项目指令生命周期', () => {
  it('首步注入合并规则，文件变化后在同一 turn 的下一次模型请求替换版本', async () => {
    const root = await temporaryDirectory()
    const home = join(root, 'home')
    const project = join(root, 'project')
    const sessions = join(root, 'sessions')
    await mkdir(join(home, '.whycode'), { recursive: true })
    await mkdir(project, { recursive: true })
    await writeFile(join(home, '.whycode', 'AGENTS.md'), '全局规则', 'utf8')
    await writeFile(join(project, 'AGENTS.md'), '项目规则一', 'utf8')
    const store = new SessionStore(sessions)
    const journal = await store.create({ projectDir: project, modelId: 'test:instructions' })
    let calls = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++
        if (calls === 1) {
          await writeFile(join(project, 'AGENTS.md'), '项目规则二', 'utf8')
          return toolStep()
        }
        return finalStep()
      },
    })
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: project, homeDir: home, osPlatform: 'win32' },
      sessionRecorder: journal,
      extraTools: [probeTool()],
      emit: () => {},
      requestApproval: async () => ({ approved: false }),
    })

    assert.equal(await session.handleUserMessage('开始任务'), 'completed')
    assert.equal(model.doStreamCalls.length, 2)
    const firstPrompt = JSON.stringify(model.doStreamCalls[0]?.prompt)
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt)
    assert.match(firstPrompt, /全局规则/)
    assert.match(firstPrompt, /项目规则一/)
    assert.doesNotMatch(firstPrompt, /项目规则二/)
    assert.match(secondPrompt, /全局规则/)
    assert.match(secondPrompt, /项目规则二/)
    assert.doesNotMatch(secondPrompt, /项目规则一/)
    assert.equal(secondPrompt.split('whycode-project-instructions').length - 1, 2)

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.initialMessages.filter(isProjectInstructionsMessage).length, 1)
    assert.equal(JSON.stringify(reopened.initialMessages).includes('项目规则二'), true)
    assert.equal(JSON.stringify(reopened.initialMessages).includes('项目规则一'), false)
    const entries = parseTranscript(
      await readFile(join(sessions, journal.sessionId, 'transcript.jsonl'), 'utf8'),
    )
    assert.equal(entries.filter((entry) => entry.type === 'project-instructions').length, 2)
  })

  it('压缩模型运行期间文件变化时，快照重新读取并保存最新原文', async () => {
    const root = await temporaryDirectory()
    const project = join(root, 'project')
    const sessions = join(root, 'sessions')
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'AGENTS.md'), '压缩前规则', 'utf8')
    const store = new SessionStore(sessions)
    const journal = await store.create({ projectDir: project, modelId: 'test:instructions' })
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        await writeFile(join(project, 'AGENTS.md'), '压缩后规则', 'utf8')
        return {
          content: [{ type: 'text', text: '<summary>对话摘要。</summary>' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: usage(),
          warnings: [],
        }
      },
    })
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: project, osPlatform: 'win32' },
      sessionRecorder: journal,
      emit: () => {},
      requestApproval: async () => ({ approved: false }),
    })
    session.restoreMessageSnapshot([
      { role: 'user', content: '较早任务' },
      { role: 'assistant', content: 'x'.repeat(200_000) },
    ])

    await session.compactNow()

    const active = JSON.stringify(session.captureMessageSnapshot())
    assert.match(active, /压缩后规则/)
    assert.doesNotMatch(active, /压缩前规则/)
    const reopened = await store.open(journal.sessionId)
    assert.match(JSON.stringify(reopened.initialMessages), /压缩后规则/)
    assert.doesNotMatch(JSON.stringify(reopened.initialMessages), /压缩前规则/)
  })
})

function probeTool() {
  return buildTool({
    name: 'InstructionProbe',
    description: '项目指令测试探针',
    prompt: '读取测试探针',
    inputSchema: z.object({}),
    isReadOnly: true,
    kind: 'read',
    async execute() {
      return { data: 'probe-ok', isError: false }
    },
  })
}

function toolStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: 'instruction-probe',
          toolName: 'InstructionProbe',
          input: '{}',
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

function finalStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'final' },
        { type: 'text-delta' as const, id: 'final', delta: '任务完成' },
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

function modelEntry(model: MockLanguageModelV4): ModelEntry {
  return {
    id: 'test:instructions',
    displayName: 'Instructions Mock',
    provider: 'openai',
    protocol: 'openai-responses',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: false,
      reasoningExposure: 'none',
      structuredOutput: 'tool-based',
      promptCaching: 'none',
      contextWindow: 100_000,
      maxOutput: 4_000,
    },
    create: () => model,
  }
}

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'whycode-agent-instructions-'))
  temporaryDirectories.push(path)
  return path
}
