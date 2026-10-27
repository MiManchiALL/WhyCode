import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { simulateReadableStream, type ModelMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import { CLEARED_MESSAGE } from '../context/microcompact.ts'
import { estimateMessageTokens } from '../context/tokens.ts'
import type { ContextUsageInfo, CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import { SkillCatalogService } from '../skills/catalog.ts'
import { SubagentDefinitionCatalogService } from '../subagents/catalog.ts'
import { createSubagentTools } from '../subagents/tools.ts'
import type { SubagentLaunchRequest } from '../subagents/types.ts'
import { buildTool } from '../tools/tool.ts'
import { localWorkspace } from '../workspace/types.ts'
import { AgentSession, type AgentSessionOptions } from './session.ts'

type ModelCall = MockLanguageModelV4['doStreamCalls'][number]
const BASELINE = '<whycode-subagent-catalog version="1">'
const DELTA = '<whycode-subagent-catalog-delta version="1">'

describe('子代理目录请求与恢复生命周期', () => {
  it('长任务每步发现增删改，冻结启动定义并保持 System、工具 schema 和顶部目录不变', async t => {
    const f = await fixture(t)
    let calls = 0
    const usages: ContextUsageInfo[] = []
    f.setStream(async () => {
      const event = f.events.findLast(event => event.type === 'context-usage')
      assert.ok(event?.type === 'context-usage' && event.usage)
      usages.push(event.usage)
      switch (++calls) {
        case 1:
          await f.writeDefinition('文档一', 'explore', '私有指令一')
          return toolStep('CatalogProbe', {}, 'add')
        case 2:
          await f.writeDefinition('文档二', 'reviewer', '私有指令二')
          return toolStep('Subagent', delegation, 'launch-one')
        case 3:
          await f.writeDefinition('文档二', 'reviewer', '私有指令三')
          return toolStep('Subagent', delegation, 'launch-two')
        case 4:
          await rm(f.definitionPath)
          return toolStep('Subagent', delegation, 'launch-three')
        default: return finalStep()
      }
    })
    assert.equal(await f.session.handleUserMessage('调查文档'), 'completed')
    assert.equal(calls, 5)
    const requests = f.model.doStreamCalls.map(call => promptTexts(call.prompt))
    assert.match(requests[0]![1]!, /whycode-project-instructions/)
    assert.match(requests[0]![2]!, /<available_subagents>/)
    assert.match(requests[0]![3]!, /whycode-skill-catalog/)
    assert.doesNotMatch(requests[0]![0]!, /available_subagents|"profile"/)
    for (const [index, call] of f.model.doStreamCalls.entries()) {
      assert.deepEqual(requests[index]!.slice(0, 4), requests[0]!.slice(0, 4))
      assert.deepEqual(call.tools, f.model.doStreamCalls[0]!.tools)
      assert.equal(requests[index]!.filter(text => text.includes(DELTA)).length, [0, 1, 2, 2, 3][index])
      assert.doesNotMatch(requests[index]!.join('\n'), /私有指令/)
      const { agents, subagents, skills, context } = usages[index]!.details.messages
      assert.equal(agents, estimateMessageTokens({ role: 'user', content: requests[0]![1]! }))
      assert.equal(subagents, estimateMessageTokens({ role: 'user', content: requests[0]![2]! }))
      assert.equal(skills, estimateMessageTokens({ role: 'user', content: requests[0]![3]! }))
      assert.equal(agents + subagents + skills + context, usages[index]!.breakdown.messageTokens)
      assert.ok(context >= requests[index]!.filter(text => text.includes(DELTA))
        .reduce((sum, content) => sum + estimateMessageTokens({ role: 'user', content }), 0))
    }
    assert.match(requests[1]!.find(text => text.includes(DELTA))!, /"added":\[\{"name":"docs"/)
    assert.match(requests[2]!.findLast(text => text.includes(DELTA))!, /"updated":\[\{"name":"docs","description":"文档二"/)
    assert.match(requests[4]!.findLast(text => text.includes(DELTA))!, /"removed":\["docs"\]/)
    const deltaIndex = requests[1]!.findIndex(text => text.includes(DELTA))
    assert.equal(f.model.doStreamCalls[1]!.prompt[deltaIndex - 1]!.role, 'tool', '增量位于已完成工具结果之后')
    assert.deepEqual(f.launched.map(request => [request.definition.profile, request.definition.instructions]), [
      ['explore', '私有指令一'], ['reviewer', '私有指令二'], ['reviewer', '私有指令三'],
    ])
    assert.equal(JSON.stringify((await f.store.open(f.journal.sessionId)).initialMessages), JSON.stringify(f.session.captureMessageSnapshot()))
  })

  it('冷恢复不重复通知；回滚和 Fork 丢掉通知后根据仍存在的配置重新补发', async t => {
    const f = await fixture(t)
    await f.session.handleUserMessage('建立基线')
    const beforeAddition = f.session.captureMessageSnapshot()
    const firstEnd = (await f.journal.readEntriesSnapshot()).findLast(entry => entry.type === 'turn-end')!
    assert.equal(firstEnd.type, 'turn-end')
    await f.journal.recordViewEvents([{ type: 'core-event', event: {
      type: 'work-finished', durationMs: 1, outcome: 'completed', forkTurnId: firstEnd.turnId,
    } }])
    await f.writeDefinition('新增文档代理')
    await f.session.handleUserMessage('发现新增项')
    assert.equal(notices(f.session.captureMessageSnapshot(), DELTA).length, 1)

    const cold = f.createSession(await f.store.open(f.journal.sessionId))
    await cold.handleUserMessage('冷恢复继续')
    assert.equal(notices(cold.captureMessageSnapshot(), DELTA).length, 1)

    const fork = f.createSession(await f.store.fork(f.journal, firstEnd.turnId))
    assert.equal(notices(fork.captureMessageSnapshot(), DELTA).length, 0)
    await fork.handleUserMessage('分支继续')
    assert.equal(notices(fork.captureMessageSnapshot(), DELTA).length, 1)

    const journal = await f.store.open(f.journal.sessionId)
    await journal.recordSnapshot('rollback', beforeAddition)
    const rolledBack = f.createSession(await f.store.open(journal.sessionId))
    assert.equal(notices(rolledBack.captureMessageSnapshot(), DELTA).length, 0)
    await rolledBack.handleUserMessage('回滚后继续')
    assert.equal(notices(rolledBack.captureMessageSnapshot(), DELTA).length, 1)
    assert.match(notices(rolledBack.captureMessageSnapshot(), DELTA)[0]!, /新增文档代理/)
  })

  for (const automatic of [false, true]) {
    it(`${automatic ? '自动' : '手动'}完整压缩排除目录和尾部增量，成功后重建最新顶部目录`, async t => {
      const f = await fixture(t)
      await f.session.handleUserMessage('建立基线')
      await f.writeDefinition('压缩前定义')
      await f.session.handleUserMessage('发现新增项')
      const messages = f.session.captureMessageSnapshot()
      const delta = messages.find(message => typeof message.content === 'string' && message.content.includes(DELTA))!
      f.session.restoreMessageSnapshot([
        ...messages.filter(message => message !== delta), ...largeHistory(),
        delta, { role: 'user', content: '最近任务' }, { role: 'assistant', content: '最近任务完成。' },
      ])
      f.setGenerate(async call => {
        assert.doesNotMatch(JSON.stringify(call.prompt), /<whycode-subagent-catalog|<available_subagents>|压缩前定义/)
        await f.writeDefinition('压缩期间更新', 'general')
        return summaryStep()
      })
      if (automatic) {
        f.entry.capabilities.contextWindow = 50_000
        assert.equal(await f.session.handleUserMessage('继续任务'), 'completed')
      } else {
        await f.session.compactNow()
        assert.equal(await f.session.handleUserMessage('继续任务'), 'completed')
      }
      assert.ok(f.model.doGenerateCalls.length > 0)
      assert.ok(f.events.some(event => event.type === 'context-compacted' && event.level === 'full'))
      const compacted = f.session.captureMessageSnapshot()
      assert.equal(notices(compacted, DELTA).length, 0)
      assert.equal(notices(compacted, BASELINE).length, 1)
      assert.match(notices(compacted, BASELINE)[0]!, /压缩期间更新/)
      assert.doesNotMatch(notices(compacted, BASELINE)[0]!, /压缩前定义/)
      const prompt = promptTexts(f.model.doStreamCalls.at(-1)!.prompt)
      assert.match(prompt[1]!, /whycode-project-instructions/)
      assert.match(prompt[2]!, /压缩期间更新/)
      assert.match(prompt[3]!, /whycode-skill-catalog/)
      assert.equal(JSON.stringify((await f.store.open(f.journal.sessionId)).initialMessages), JSON.stringify(compacted))
    })

    it(`${automatic ? '自动' : '手动'}完整压缩保存失败时保留原目录和增量，冷恢复仍能补发`, async t => {
      const f = await fixture(t)
      await f.session.handleUserMessage('建立基线')
      await f.writeDefinition('压缩前定义')
      await f.session.handleUserMessage('发现新增项')
      const before = [...f.session.captureMessageSnapshot(), ...largeHistory()]
      f.session.restoreMessageSnapshot(before)
      await f.journal.recordSnapshot('rollback', before)
      await f.writeDefinition('尚未通知的更新', 'reviewer')
      const recordSnapshot = f.journal.recordSnapshot.bind(f.journal)
      f.journal.recordSnapshot = async () => { throw new Error('压缩快照写入失败') }
      const streamCalls = f.model.doStreamCalls.length
      if (automatic) {
        f.entry.capabilities.contextWindow = 50_000
        assert.equal(await f.session.handleUserMessage('继续任务'), 'error')
      } else await f.session.compactNow()
      assert.ok(f.model.doGenerateCalls.length > 0)
      assert.equal(f.model.doStreamCalls.length, streamCalls)
      assert.equal(f.events.some(event => event.type === 'context-compacted'), false)
      assert.ok(f.events.some(event => event.type === 'error' && event.message.includes('压缩快照写入失败')))
      assert.deepEqual(notices(f.session.captureMessageSnapshot(), BASELINE), notices(before, BASELINE))
      assert.deepEqual(notices(f.session.captureMessageSnapshot(), DELTA), notices(before, DELTA))
      f.journal.recordSnapshot = recordSnapshot
      f.entry.capabilities.contextWindow = 100_000
      const cold = f.createSession(await f.store.open(f.journal.sessionId))
      assert.equal(await cold.handleUserMessage('重新继续'), 'completed')
      assert.deepEqual(notices(cold.captureMessageSnapshot(), BASELINE), notices(before, BASELINE))
      assert.match(notices(cold.captureMessageSnapshot(), DELTA).at(-1)!, /尚未通知的更新/)
    })
  }

  it('microcompact 只清理旧工具输出，不合并目录和增量；下一请求再通知变化', async t => {
    const f = await fixture(t)
    await f.session.handleUserMessage('建立基线')
    await f.writeDefinition('第一版')
    await f.session.handleUserMessage('发现新增项')
    const before = f.session.captureMessageSnapshot()
    const reads = Array.from({ length: 7 }, (_, index): ModelMessage[] => [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `read-${index}`, toolName: 'ReadFile', input: { path: 'a.txt' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: `read-${index}`, toolName: 'ReadFile', output: { type: 'text', value: '文件内容'.repeat(50) } }] },
    ]).flat()
    f.session.restoreMessageSnapshot([...before, ...reads, { role: 'assistant', content: '读取结束。' }])
    await f.writeDefinition('第二版', 'reviewer')
    await f.session.compactNow()
    const after = f.session.captureMessageSnapshot()
    assert.ok(f.events.some(event => event.type === 'context-compacted' && event.level === 'micro'))
    assert.equal(f.model.doGenerateCalls.length, 0)
    assert.ok(JSON.stringify(after).includes(CLEARED_MESSAGE))
    assert.deepEqual(notices(after, BASELINE), notices(before, BASELINE))
    assert.deepEqual(notices(after, DELTA), notices(before, DELTA))
    await f.session.handleUserMessage('继续')
    assert.equal(notices(f.session.captureMessageSnapshot(), DELTA).length, 2)
    assert.match(notices(f.session.captureMessageSnapshot(), DELTA).at(-1)!, /第二版/)
    assert.deepEqual(notices(f.session.captureMessageSnapshot(), BASELINE), notices(before, BASELINE))
  })

  it('未提交的模型响应不记为已通知，重试会重新提供目录', async t => {
    const f = await fixture(t)
    f.setStream(async () => { throw new Error('模型响应失败') })
    assert.equal(await f.session.handleUserMessage('首次失败'), 'error')
    assert.equal(notices((await f.store.open(f.journal.sessionId)).initialMessages, BASELINE).length, 0)
    await f.writeDefinition('重试前新增')
    f.setStream(async () => finalStep())
    const cold = f.createSession(await f.store.open(f.journal.sessionId))
    assert.equal(await cold.handleUserMessage('重新执行'), 'completed')
    assert.equal(notices(cold.captureMessageSnapshot(), BASELINE).length, 1)
    assert.match(notices(cold.captureMessageSnapshot(), BASELINE)[0]!, /重试前新增/)
  })

  it('目录读取失败不作为删除通知，也不携带旧快照继续请求', async t => {
    const f = await fixture(t)
    await f.session.handleUserMessage('建立基线')
    const cold = f.createSession(await f.store.open(f.journal.sessionId), {
      loadSubagentCatalog: async () => { throw new Error('目录不可读') },
    })
    const before = f.model.doStreamCalls.length
    assert.equal(await cold.handleUserMessage('继续'), 'error')
    assert.equal(f.model.doStreamCalls.length, before)
    assert.equal(notices(cold.captureMessageSnapshot(), DELTA).length, 0)
    assert.ok(f.events.some(event => event.type === 'error' && event.message.includes('目录不可读')))
  })
})

async function fixture(t: TestContext) {
  const temporaryDirectory = await realpath(tmpdir())
  const root = await mkdtemp(join(temporaryDirectory, 'whycode-subagent-catalog-'))
  const home = join(root, 'home')
  const project = join(root, 'project')
  const definitionPath = join(project, '.whycode', 'agents', 'docs.md')
  await mkdir(dirname(definitionPath), { recursive: true })
  await mkdir(join(home, '.whycode', 'skills', 'guide'), { recursive: true })
  await writeFile(join(home, '.whycode', 'skills', 'guide', 'SKILL.md'), '---\nname: guide\ndescription: 测试流程\n---\n流程正文')
  await writeFile(join(project, 'AGENTS.md'), '项目规则')
  const store = new SessionStore(join(root, 'sessions'))
  const journal = await store.create({ workspace: localWorkspace(project), modelId: 'test:catalog' })
  const events: CoreEvent[] = []
  const sessions: AgentSession[] = []
  const launched: SubagentLaunchRequest[] = []
  const catalog = new SubagentDefinitionCatalogService({ homeDir: home })
  let stream: MockLanguageModelV4['doStream'] = async () => finalStep()
  let generate: MockLanguageModelV4['doGenerate'] = async () => summaryStep()
  const model = new MockLanguageModelV4({ doStream: call => stream(call), doGenerate: call => generate(call) })
  const entry: ModelEntry = {
    id: 'test:catalog', displayName: 'Catalog', provider: 'openai', protocol: 'openai-responses',
    capabilities: {
      supportsNativeTools: true, supportsImageInput: false, reasoningExposure: 'none',
      structuredOutput: 'tool-based', promptCaching: 'none', contextWindow: 100_000, maxOutput: 4_000,
    },
    create: () => model,
  }
  const options: AgentSessionOptions = {
    model: entry, providerConfig: { apiKey: 'test' }, promptContext: { projectDir: project, homeDir: home, osPlatform: 'win32' },
    skillCatalog: new SkillCatalogService({ homeDir: home }), loadSubagentCatalog: () => catalog.snapshot(project),
    emit: event => events.push(event), requestApproval: async () => ({ approved: true }),
    extraTools: [
      buildTool({ name: 'CatalogProbe', description: '读取当前任务状态', prompt: '读取状态', kind: 'read',
        inputSchema: z.object({}).strict(), execute: async () => ({ data: '继续任务', isError: false }),
      }),
      ...createSubagentTools({
        launch: async request => {
          launched.push(request)
          return { ok: true, subagentId: randomUUID(), name: request.definition.name, description: request.taskDescription }
        },
        continue: async request => ({ ok: true, subagentId: request.subagentId }), list: async () => [],
      }),
    ],
  }
  function createSession(recorder = journal, overrides: Partial<AgentSessionOptions> = {}) {
    const session = new AgentSession({ ...options, ...overrides, sessionRecorder: recorder })
    sessions.push(session)
    return session
  }
  t.after(async () => {
    await Promise.all(sessions.map(session => session.dispose()))
    assert.equal(dirname(root), temporaryDirectory)
    await rm(root, { recursive: true, force: true })
  })
  return {
    store, journal, model, entry, events, launched, definitionPath, createSession, session: createSession(),
    setStream: (next: typeof stream) => { stream = next },
    setGenerate: (next: typeof generate) => { generate = next },
    writeDefinition: (description: string, profile = 'explore', instructions = '核实资料。') =>
      writeFile(definitionPath, `---\nname: docs\ndescription: ${description}\nprofile: ${profile}\n---\n${instructions}`),
  }
}

function notices(messages: readonly ModelMessage[], marker: string): string[] {
  return messages.flatMap(message => typeof message.content === 'string' && message.content.includes(marker) ? [message.content] : [])
}

function promptTexts(prompt: ModelCall['prompt']): string[] {
  return prompt.map(message => typeof message.content === 'string' ? message.content
    : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'))
}

function largeHistory(): ModelMessage[] {
  return Array.from({ length: 3 }, (_, index): ModelMessage[] => [
    { role: 'user', content: `旧任务 ${index}：${'x'.repeat(64_000)}` },
    { role: 'assistant', content: '旧任务完成。' },
  ]).flat()
}

const delegation = { name: 'docs', description: '核实文档', prompt: '检查文档与实现是否一致。' }
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
}

function toolStep(toolName: string, input: unknown, toolCallId: string) {
  return { stream: simulateReadableStream({ chunks: [
    { type: 'tool-call' as const, toolCallId, toolName, input: JSON.stringify(input) },
    { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
  ] }) }
}

function finalStep() {
  return { stream: simulateReadableStream({ chunks: [
    { type: 'text-start' as const, id: 'reply' },
    { type: 'text-delta' as const, id: 'reply', delta: '已完成。' },
    { type: 'text-end' as const, id: 'reply' },
    { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
  ] }) }
}

function summaryStep() {
  return { content: [{ type: 'text' as const, text: '<summary>旧任务已完成。</summary>' }],
    finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [],
  }
}
