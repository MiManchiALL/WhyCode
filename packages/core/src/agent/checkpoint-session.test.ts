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
import { isStepScopedCoreEvent, type CoreEvent } from '../events.ts'
import { estimateMessagesTokens } from '../context/tokens.ts'
import { SkillCatalogService } from '../skills/catalog.ts'
import { applySkillContext } from '../skills/context.ts'
import { visibleCoreEventSchema } from '../session/view-events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import { createUserQuestionMarker } from '../tasks/answer-resume.ts'
import {
  CLOSE_TASK_PLAN_TOOL_NAME,
  CREATE_TASK_PLAN_TOOL_NAME,
} from '../tasks/tools.ts'
import {
  activeTaskPlanSchema,
  type TaskPlanState,
} from '../tasks/types.ts'
import { AgentSession } from './session.ts'
import { localWorkspace } from '../workspace/types.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('Agent 资源检查点联动', () => {
  it('净变化通过运行态实时投影，插队不重置，结束和新 turn 不残留统计', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'whycode-turn-changes-'))
    roots.push(root)
    const path = join(root, 'net.txt')
    await writeFile(path, 'original\n')
    const recorder = await new SessionStore(join(root, 'sessions')).create({
      workspace: localWorkspace(root), modelId: 'test:checkpoint',
    })
    const events: CoreEvent[] = []
    let step = 0
    const model: MockLanguageModelV4 = new MockLanguageModelV4({
      doStream: async () => {
        switch (step++) {
          case 0:
            return toolStep('WriteFile', { path, content: 'original\n1\n2\n3\n4\n5\n' }, 'add')
          case 1:
            assert.deepEqual(session.turnFileChanges, [{ path, added: 5, removed: 0 }])
            return toolStep('WriteFile', { path, content: 'original\n' }, 'undo')
          case 2:
            assert.deepEqual(session.turnFileChanges, [])
            return textStep('完成', 'first-final')
          case 3:
            assert.deepEqual(session.turnFileChanges, [])
            return toolStep('WriteFile', { path, content: 'replacement\n' }, 'replace')
          default:
            assert.deepEqual(session.turnFileChanges, [{ path, added: 1, removed: 1 }])
            return textStep('完成', 'second-final')
        }
      },
    })
    const session = new AgentSession({
      model: modelEntry(model), providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: root, osPlatform: process.platform }, sessionRecorder: recorder,
      requestApproval: async () => ({ approved: true, remember: false }),
      emit: event => {
        events.push(event)
        if (event.type === 'turn-file-changes' && step === 1) session.handleUserMessage('补充：继续完成')
      },
    })
    assert.equal(await session.handleUserMessage('追加后撤销五行'), 'completed')
    assert.equal(events.filter(event => event.type === 'turn-start').length, 1)
    assert.ok(events.some(event => event.type === 'message-injected'))
    assert.deepEqual(session.turnFileChanges, [])
    assert.equal(await session.handleUserMessage('替换一行'), 'completed')
    assert.deepEqual(session.turnFileChanges, [])
    const changes = events.filter(event => event.type === 'turn-file-changes')
    assert.deepEqual(changes.map(event => event.changes), [
      [{ path, added: 5, removed: 0 }], [], [{ path, added: 1, removed: 1 }],
    ])
    for (const event of changes) {
      assert.equal(isStepScopedCoreEvent(event), false)
      assert.equal(visibleCoreEventSchema.safeParse(event).success, false)
    }
    const toolChanges = events.filter(event => event.type === 'tool-end')
    assert.deepEqual(toolChanges[1]?.fileChanges, [{ path, added: 0, removed: 5 }])
  })

  it('单次批准项目外写入后建立精确检查点，并合并重复回滚请求', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'whycode-agent-checkpoint-'))
    roots.push(root)
    const project = join(root, 'project')
    const external = join(root, 'external')
    // 敏感文件不会提供“记住目录”建议；单次批准仍必须能执行并精确回滚。
    const target = join(external, '.env.local')
    await Promise.all([mkdir(project), mkdir(external)])
    const recorder = await new SessionStore(join(root, 'sessions')).create({
      workspace: localWorkspace(project),
      modelId: 'test:checkpoint',
    })
    const events: CoreEvent[] = []
    const scheduledMutations: string[] = []
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
      scheduleProjectMutation: async (mutation, _signal, operation) => {
        scheduledMutations.push(mutation.type)
        return operation()
      },
    })

    assert.equal(await session.handleUserMessage('在外部目录创建文件'), 'completed')
    assert.equal(approvals, 1)
    assert.equal(await readFile(target, 'utf8'), 'hello')
    assert.deepEqual(scheduledMutations, ['tool'])
    const checkpoint = events.find((event) => event.type === 'checkpoint-created')
    assert.ok(checkpoint?.type === 'checkpoint-created')
    assert.equal(checkpoint.coverage, 'complete')

    const checked = await session.checkCheckpointRestore(checkpoint.toolUseId, 'files')
    assert.equal(checked.ok, true, checked.error)
    assert.equal(await readFile(target, 'utf8'), 'hello')
    assert.deepEqual(scheduledMutations, ['tool'])

    await Promise.all([
      session.restoreCheckpoint(checkpoint.toolUseId, 'files'),
      session.restoreCheckpoint(checkpoint.toolUseId, 'files'),
    ])

    await assert.rejects(access(target))
    const restored = events.filter((event) => event.type === 'checkpoint-restored')
    assert.equal(restored.length, 1)
    assert.equal(restored[0]?.type === 'checkpoint-restored' && restored[0].ok, true)
    assert.deepEqual(scheduledMutations, ['tool', 'checkpoint-restore'])
  })

  it('文件和对话回滚到 Ask 等待点时原子恢复问题卡', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'whycode-question-rollback-'))
    roots.push(root)
    const project = join(root, 'project')
    await mkdir(project)
    const target = join(project, 'answer.txt')
    const recorder = await new SessionStore(join(root, 'sessions')).create({
      workspace: localWorkspace(project),
      modelId: 'test:checkpoint',
    })
    const question = {
      id: 'question-before-checkpoint',
      questions: [
        {
          header: '实现偏好',
          question: '采用哪种实现？',
          options: [
            { label: '简单实现', description: '优先减少复杂度' },
            { label: '完整实现', description: '优先覆盖更多场景' },
          ],
        },
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

  for (const keepEarlierTurn of [false, true]) {
    it(`文件和对话回滚${keepEarlierTurn ? '保留早期对话' : '到空历史'}后计量只包含保留消息及请求上下文`, async () => {
      const root = await mkdtemp(join(await realpath(tmpdir()), 'whycode-context-restore-'))
      roots.push(root)
      const project = join(root, 'project')
      const home = join(root, 'home')
      const skillRoot = join(home, '.whycode', 'skills', 'context-probe')
      await Promise.all([mkdir(project), mkdir(skillRoot, { recursive: true })])
      await writeFile(join(skillRoot, 'SKILL.md'), '---\nname: context-probe\ndescription: 核对上下文\n---\n核对当前请求。')
      const target = join(project, 'old.txt')
      const store = new SessionStore(join(root, 'sessions'))
      const recorder = await store.create({ workspace: localWorkspace(project), modelId: 'test:checkpoint' })
      const events: CoreEvent[] = []
      const latestUsage = () => {
        const event = events.findLast(event => event.type === 'context-usage')
        assert.ok(event?.type === 'context-usage' && event.usage)
        return event.usage
      }
      const model = new MockLanguageModelV4({ doStream: [
        ...(keepEarlierTurn ? [textStep('EARLIER_REPLY', 'earlier')] : []),
        toolStep('WriteFile', { path: target, content: 'REMOVED_FILE_CONTENT' }, 'write-old'),
        textStep('REMOVED_REPLY', 'old-final'),
        textStep('你好', 'new-final'),
      ] })
      const skillCatalog = new SkillCatalogService({ homeDir: home })
      const options = {
        model: modelEntry(model), providerConfig: { apiKey: 'test' },
        promptContext: { projectDir: project, homeDir: home, osPlatform: process.platform },
        sessionRecorder: recorder, skillCatalog,
        emit: (event: CoreEvent) => events.push(event),
        requestApproval: async () => ({ approved: true }),
      }
      const session = new AgentSession(options)
      await session.initializeContextUsage()
      assert.ok(latestUsage().breakdown.messageTokens > 0, '空历史仍包含 Skill 目录开销')
      if (keepEarlierTurn) assert.equal(await session.handleUserMessage('EARLIER_QUESTION'), 'completed')
      const prefix = structuredClone(recorder.initialMessages)
      assert.equal(await session.handleUserMessage('REMOVED_QUESTION'), 'completed')
      const checkpoint = events.find(event => event.type === 'checkpoint-created')
      assert.ok(checkpoint?.type === 'checkpoint-created')

      await session.restoreCheckpoint(checkpoint.toolUseId, 'files-and-chat')
      await assert.rejects(access(target))
      assert.deepEqual(recorder.initialMessages, prefix)
      const snapshot = await skillCatalog.snapshot(project, 100_000)
      const restoredUsage = latestUsage()
      assert.equal(restoredUsage.breakdown.messageTokens, estimateMessagesTokens(applySkillContext(prefix, snapshot, [], new Set())))
      assert.equal(restoredUsage.usedTokens, Object.values(restoredUsage.breakdown).reduce((sum, tokens) => sum + tokens, 0), '旧 Provider 基线已失效')
      const reopened = await store.open(recorder.sessionId)
      await new AgentSession({ ...options, sessionRecorder: reopened }).initializeContextUsage()
      assert.deepEqual(latestUsage(), restoredUsage, '运行中回滚和重新打开使用同一计量')

      assert.equal(await session.handleUserMessage('你好'), 'completed')
      const request = JSON.stringify(model.doStreamCalls.at(-1)?.prompt)
      assert.doesNotMatch(request, /REMOVED_/u)
      assert.equal(request.includes('EARLIER_QUESTION'), keepEarlierTurn)
      assert.match(request, /whycode-skill-catalog/u)
      assert.equal(latestUsage().breakdown.messageTokens, estimateMessagesTokens(applySkillContext(recorder.initialMessages, snapshot, [], new Set())))
    })
  }

  it('结束旧计划并创建新计划后，文件和对话回滚会恢复原活动计划', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'whycode-plan-switch-'))
    roots.push(root)
    const project = join(root, 'project')
    const target = join(project, 'csgo.html')
    await mkdir(project)
    const store = new SessionStore(join(root, 'sessions'))
    const recorder = await store.create({
      workspace: localWorkspace(project),
      modelId: 'test:checkpoint',
    })
    const oldPlan = activeTaskPlanSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      goal: '开发蔚蓝游戏',
      status: 'active',
      revision: 2,
      items: [
        {
          id: 'T1', kind: 'work', outcome: '游戏核心已经可运行',
          status: 'in_progress', evidence: [],
        },
        {
          id: 'T2', kind: 'work', outcome: '关卡与交互已经完整',
          status: 'pending', evidence: [],
        },
        {
          id: 'T3', kind: 'verification', outcome: '游戏整体运行无误',
          status: 'pending', evidence: [],
        },
      ],
    })
    const oldState: TaskPlanState = {
      version: 7,
      activePlan: oldPlan,
      resumeRequired: true,
      interruptionReason: 'user-cancel',
    }
    await recorder.recordTurnStart('old-plan', [{ role: 'user', content: '开发蔚蓝' }])
    await recorder.recordStep('old-plan', [{ role: 'assistant', content: '已建立计划' }], oldState)
    await recorder.recordTurnEnd('old-plan', 'paused')
    const events: CoreEvent[] = []
    const session = new AgentSession({
      model: modelEntry(modelSwitchingAndWriting(target)),
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
      workspace: localWorkspace(project),
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

function modelSwitchingAndWriting(path: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {}, 'close-old-plan'),
      toolStep('ListDir', { path: '.', limit: 20 }, 'scan-project'),
      toolStep(CREATE_TASK_PLAN_TOOL_NAME, {
        goal: '开发 CSGO 游戏',
        items: [
          { kind: 'work', outcome: 'CSGO 核心玩法已经可运行' },
          { kind: 'work', outcome: '界面与交互已经完整' },
          { kind: 'verification', outcome: 'CSGO 游戏整体运行无错误' },
        ],
      }, 'create-new-plan'),
      toolStep('WriteFile', { path, content: 'csgo' }, 'write-csgo'),
      textStep('切换完成', 'switch-final'),
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
