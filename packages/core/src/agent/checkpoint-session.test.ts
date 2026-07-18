import assert from 'node:assert/strict'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import { createUserQuestionMarker } from '../tasks/answer-resume.ts'
import {
  CLOSE_TASK_PLAN_TOOL_NAME,
  REPLACE_TASK_PLAN_TOOL_NAME,
} from '../tasks/tools.ts'
import {
  activeTaskPlanSchema,
  type TaskPlanState,
} from '../tasks/types.ts'
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

  it('替换计划后的文件和对话回滚会恢复旧活动计划并移除新文件', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'whycode-plan-replacement-'))
    roots.push(root)
    const project = join(root, 'project')
    const target = join(project, 'csgo.html')
    await mkdir(project)
    const store = new SessionStore(join(root, 'sessions'))
    const recorder = await store.create({
      projectDir: project,
      modelId: 'test:checkpoint',
    })
    const oldPlan = activeTaskPlanSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      goal: '开发蔚蓝游戏',
      status: 'active',
      revision: 2,
      items: [
        {
          id: 'T1', kind: 'work', title: '实现游戏', acceptance: '可以运行',
          status: 'in_progress', evidence: [],
        },
        {
          id: 'T2', kind: 'verification', title: '验证游戏', acceptance: '运行无误',
          status: 'pending', evidence: [],
        },
      ],
    })
    const oldState: TaskPlanState = {
      version: 7,
      activePlan: oldPlan,
      historicalPlans: [{
        id: '33333333-3333-4333-8333-333333333333',
        goal: '完成 Minecraft 游戏',
        status: 'completed',
        summary: '功能和验证均已完成',
        completedItems: 2,
        totalItems: 2,
        revision: 4,
      }],
      resumeRequired: true,
      interruptionReason: 'user-cancel',
    }
    await recorder.recordTurnStart('old-plan', [{ role: 'user', content: '开发蔚蓝' }])
    await recorder.recordStep('old-plan', [{ role: 'assistant', content: '已建立计划' }], oldState)
    await recorder.recordTurnEnd('old-plan', 'paused')
    const events: CoreEvent[] = []
    const session = new AgentSession({
      model: modelEntry(modelReplacingAndWriting(target)),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: project, osPlatform: process.platform },
      sessionRecorder: recorder,
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: true }),
    })

    assert.equal(
      await session.handleUserMessage('放弃当前蔚蓝任务，切换到完整开发 CSGO'),
      'completed',
    )
    const checkpoint = events.find((event) => event.type === 'checkpoint-created')
    assert.ok(checkpoint?.type === 'checkpoint-created')
    assert.equal(await readFile(target, 'utf8'), 'csgo')

    await session.restoreCheckpoint(checkpoint.toolUseId, 'files-and-chat')

    await assert.rejects(access(target))
    assert.deepEqual(session.captureTaskStateSnapshot()?.activePlan, oldPlan)
    assert.deepEqual(session.captureTaskStateSnapshot(), oldState)
    assert.deepEqual((await store.open(recorder.sessionId)).initialTaskState, oldState)
    const restored = events.findLast((event) => event.type === 'checkpoint-restored')
    assert.equal(restored?.type === 'checkpoint-restored' && restored.ok, true)
    assert.deepEqual(restored?.type === 'checkpoint-restored' ? restored.taskPlan : null, oldPlan)
  })

  it('RunCommand 在超大工作区也不扫描或建立文件检查点', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'whycode-command-no-checkpoint-'))
    roots.push(root)
    const project = join(root, 'project')
    await mkdir(project)
    const oversized = join(project, 'oversized.csv')
    await writeFile(oversized, '')
    await truncate(oversized, 65 * 1024 * 1024)
    const recorder = await new SessionStore(join(root, 'sessions')).create({
      projectDir: project,
      modelId: 'test:checkpoint',
    })
    const events: CoreEvent[] = []
    const session = new AgentSession({
      model: modelEntry(modelRunningCommand()),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: project, osPlatform: process.platform },
      sessionRecorder: recorder,
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: true }),
    })

    assert.equal(await session.handleUserMessage('运行一个短命令'), 'completed')
    assert.equal(events.some((event) => event.type === 'checkpoint-created'), false)
    assert.equal(events.some((event) => event.type === 'checkpoint-disabled'), false)
  })
})

function modelRunningCommand(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      toolStep('RunCommand', { command: 'echo ok' }, 'run-command-without-checkpoint'),
      textStep('命令完成', 'command-final'),
    ],
  })
}

function modelReplacingAndWriting(path: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      toolStep(REPLACE_TASK_PLAN_TOOL_NAME, {
        expected_active_plan_id: '11111111-1111-4111-8111-111111111111',
        replacement_authorized: true,
        goal: '开发 CSGO 游戏',
        reason: '用户明确切换到新的独立游戏任务',
        items: [
          { kind: 'work', title: '实现 CSGO', acceptance: '游戏可以运行' },
          { kind: 'verification', title: '验证 CSGO', acceptance: '运行无错误' },
        ],
      }, 'replace-plan'),
      toolStep('WriteFile', { path, content: 'csgo' }, 'write-csgo'),
      toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {
        outcome: 'abandoned',
        summary: '测试结束',
      }, 'close-plan'),
      textStep('替换完成', 'replacement-final'),
    ],
  })
}

function modelWriting(path: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      toolStep('WriteFile', { path, content: 'hello' }, 'write-external'),
      textStep('已创建', 'final'),
    ],
  })
}

function toolStep(toolName: string, input: unknown, id: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: id,
          toolName,
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

function textStep(text: string, id: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id },
        { type: 'text-delta' as const, id, delta: text },
        { type: 'text-end' as const, id },
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
    id: 'test:checkpoint',
    displayName: 'Checkpoint Mock',
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
