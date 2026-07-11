import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import { createUserQuestionMarker } from '../tasks/answer-resume.ts'
import { AgentSession } from './session.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Agent 资源检查点联动', () => {
  it('单次批准项目外写入后建立精确检查点，并合并重复回滚请求', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'whycode-agent-checkpoint-'))
    roots.push(root)
    const project = join(root, 'project')
    const external = join(root, 'external')
    // 敏感文件不会提供“记住目录”建议；单次批准仍必须能执行并精确回滚。
    const target = join(external, '.env.local')
    await Promise.all([mkdir(project), mkdir(external)])
    const recorder = await new SessionStore(join(root, 'sessions')).create({
      projectDir: project,
      modelId: 'test:checkpoint',
    })
    const events: CoreEvent[] = []
    let approvals = 0
    const session = new AgentSession({
      model: modelEntry(modelWriting(target)),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: project, osPlatform: process.platform },
      checkpointStorageDir: join(root, 'checkpoints'),
      sessionRecorder: recorder,
      emit: (event) => events.push(event),
      requestApproval: async () => {
        approvals++
        return { approved: true, remember: false }
      },
    })

    assert.equal(await session.handleUserMessage('在外部目录创建文件'), 'completed')
    assert.equal(approvals, 1)
    assert.equal(await readFile(target, 'utf8'), 'hello')
    const checkpoint = events.find((event) => event.type === 'checkpoint-created')
    assert.ok(checkpoint?.type === 'checkpoint-created')
    assert.equal(checkpoint.coverage, 'complete')

    await Promise.all([
      session.restoreCheckpoint(checkpoint.toolUseId, 'files'),
      session.restoreCheckpoint(checkpoint.toolUseId, 'files'),
    ])

    await assert.rejects(access(target))
    const restored = events.filter((event) => event.type === 'checkpoint-restored')
    assert.equal(restored.length, 1)
    assert.equal(restored[0]?.type === 'checkpoint-restored' && restored[0].ok, true)
  })

  it('文件和对话回滚到 Ask 等待点时原子恢复问题卡', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'whycode-question-rollback-'))
    roots.push(root)
    const project = join(root, 'project')
    await mkdir(project)
    const target = join(project, 'answer.txt')
    const recorder = await new SessionStore(join(root, 'sessions')).create({
      projectDir: project,
      modelId: 'test:checkpoint',
    })
    const question = {
      id: 'question-before-checkpoint',
      header: '实现偏好',
      question: '采用哪种实现？',
      options: [
        { label: '简单实现', description: '优先减少复杂度' },
        { label: '完整实现', description: '优先覆盖更多场景' },
      ],
    }
    await recorder.recordTurnStart('question-turn', [{ role: 'user', content: '继续任务' }])
    await recorder.recordStep('question-turn', [createUserQuestionMarker(question, false)])
    await recorder.recordTurnEnd('question-turn', 'waiting-user')
    const events: CoreEvent[] = []
    const session = new AgentSession({
      model: modelEntry(modelWriting(target)),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: project, osPlatform: process.platform },
      checkpointStorageDir: join(root, 'checkpoints'),
      sessionRecorder: recorder,
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: true }),
    })

    assert.equal(
      await session.handleUserMessage('回答「采用哪种实现？」：简单实现'),
      'completed',
    )
    const checkpoint = events.find((event) => event.type === 'checkpoint-created')
    assert.ok(checkpoint?.type === 'checkpoint-created')
    await session.restoreCheckpoint(checkpoint.toolUseId, 'files-and-chat')

    const restored = events.findLast((event) => event.type === 'checkpoint-restored')
    assert.ok(restored?.type === 'checkpoint-restored' && restored.ok)
    assert.deepEqual(restored.question, question)
    await assert.rejects(access(target))
  })
})

function modelWriting(path: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      {
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'tool-call' as const,
              toolCallId: 'write-external',
              toolName: 'WriteFile',
              input: JSON.stringify({ path, content: 'hello' }),
            },
            {
              type: 'finish' as const,
              finishReason: { unified: 'tool-calls' as const, raw: undefined },
              usage: usage(),
            },
          ],
        }),
      },
      {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start' as const, id: 'final' },
            { type: 'text-delta' as const, id: 'final', delta: '已创建' },
            { type: 'text-end' as const, id: 'final' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: undefined },
              usage: usage(),
            },
          ],
        }),
      },
    ],
  })
}

function modelEntry(model: MockLanguageModelV4): ModelEntry {
  return {
    id: 'test:checkpoint',
    displayName: 'Checkpoint Mock',
    provider: 'openai',
    capabilities: {
      supportsNativeTools: true,
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
