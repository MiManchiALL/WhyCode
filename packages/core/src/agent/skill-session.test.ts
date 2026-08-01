import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { ModelEntry } from '../providers/registry.ts'
import { SkillCatalogService } from '../skills/catalog.ts'
import { SKILL_TOOL_NAME } from '../tools/skill/index.ts'
import { AgentSession } from './session.ts'

const temporaryDirectories: string[] = []
const BODY = 'CURRENT_TURN_SKILL_BODY_7f0d'
const RESOURCE_BODY = 'CURRENT_TURN_RESOURCE_BODY_31aa'

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('Agent Skill 根任务生命周期', () => {
  it('显式选择在首个模型请求前注入，下一根任务不继承正文', async () => {
    const fixture = await skillFixture()
    const catalog = new SkillCatalogService({ homeDir: fixture.home })
    const listed = await catalog.list(fixture.project, 100_000)
    const { id, path } = listed.skills[0]!
    const selected = await catalog.activate({ id, path }, fixture.project, 100_000)
    const model = new MockLanguageModelV4({ doStream: async () => finalStep() })
    const session = createSession(model, fixture, catalog)

    assert.equal(await session.handleUserMessage('按所选流程执行', false, [], undefined, [], [selected]), 'completed')
    assert.equal(await session.handleUserMessage('普通下一任务'), 'completed')

    const first = JSON.stringify(model.doStreamCalls[0]?.prompt)
    const second = JSON.stringify(model.doStreamCalls[1]?.prompt)
    assert.match(first, /whycode-active-skill/)
    assert.match(first, new RegExp(BODY))
    assert.doesNotMatch(second, /whycode-active-skill/)
    assert.doesNotMatch(second, new RegExp(BODY))
  })

  it('隐式目录通过 Skill 工具按精确 id 加载，历史结果在下一根任务冻结', async () => {
    const fixture = await skillFixture()
    const catalog = new SkillCatalogService({ homeDir: fixture.home })
    const listed = await catalog.list(fixture.project, 100_000)
    const skillId = listed.skills[0]!.id
    let calls = 0
    const model = new MockLanguageModelV4({
      doStream: async () => ++calls === 1 ? toolStep(skillId) : finalStep(),
    })
    const session = createSession(model, fixture, catalog)

    assert.equal(await session.handleUserMessage('这个任务适合目录里的流程'), 'completed')
    assert.equal(await session.handleUserMessage('开始无关的新任务'), 'completed')

    assert.ok(toolNames(model.doStreamCalls[0]).includes(SKILL_TOOL_NAME))
    assert.match(JSON.stringify(model.doStreamCalls[0]?.prompt), /available_skills/)
    const activatedRequest = JSON.stringify(model.doStreamCalls[1]?.prompt)
    assert.match(activatedRequest, /whycode-active-skill/)
    assert.match(activatedRequest, new RegExp(BODY))
    assert.match(activatedRequest, /Skill 工具正文不作为长期历史/)
    const nextRoot = JSON.stringify(model.doStreamCalls[2]?.prompt)
    assert.doesNotMatch(nextRoot, new RegExp(BODY))
    assert.match(nextRoot, /Skill 工具正文不作为长期历史/)
  })

  it('模型重复调用同一 Skill 时不覆盖用户已选择的冻结快照', async () => {
    const fixture = await skillFixture()
    const catalog = new SkillCatalogService({ homeDir: fixture.home })
    const listed = await catalog.list(fixture.project, 100_000)
    const { id, path } = listed.skills[0]!
    const selected = await catalog.activate({ id, path }, fixture.project, 100_000)
    await writeFile(path, [
      '---',
      'name: verify-build',
      'description: 磁盘新版',
      '---',
      'DISK_NEW_SKILL_BODY_91bd',
    ].join('\n'), 'utf8')
    let calls = 0
    const model = new MockLanguageModelV4({
      doStream: async () => ++calls === 1 ? toolStep(id) : finalStep(),
    })
    const session = createSession(model, fixture, catalog)

    assert.equal(
      await session.handleUserMessage('继续使用已选择版本', false, [], undefined, [], [selected]),
      'completed',
    )
    const followup = JSON.stringify(model.doStreamCalls[1]?.prompt)
    assert.match(followup, new RegExp(BODY))
    assert.doesNotMatch(followup, /DISK_NEW_SKILL_BODY_91bd/)
  })

  it('包内参考资料在当前根任务保留，主 Skill 正文同时提升为活动上下文', async () => {
    const fixture = await skillFixture()
    const catalog = new SkillCatalogService({ homeDir: fixture.home })
    const listed = await catalog.list(fixture.project, 100_000)
    const skillId = listed.skills[0]!.id
    let calls = 0
    const model = new MockLanguageModelV4({
      doStream: async () => ++calls === 1
        ? toolStep(skillId, 'references/guide.md')
        : finalStep(),
    })
    const session = createSession(model, fixture, catalog)

    assert.equal(await session.handleUserMessage('读取 Skill 的参考资料'), 'completed')
    assert.equal(await session.handleUserMessage('开始下一项普通任务'), 'completed')
    const followup = JSON.stringify(model.doStreamCalls[1]?.prompt)
    assert.match(followup, new RegExp(RESOURCE_BODY))
    assert.match(followup, new RegExp(BODY))
    const nextRoot = JSON.stringify(model.doStreamCalls[2]?.prompt)
    assert.doesNotMatch(nextRoot, new RegExp(RESOURCE_BODY))
    assert.doesNotMatch(nextRoot, new RegExp(BODY))
  })

  it('讨论和协议边界物理移除 Skill 工具', async () => {
    const fixture = await skillFixture()
    const catalog = new SkillCatalogService({ homeDir: fixture.home })
    const model = new MockLanguageModelV4({ doStream: async () => finalStep() })
    const session = createSession(model, fixture, catalog, {
      agentId: 'Main',
      scratchDir: join(fixture.project, '.scratch'),
    })

    assert.equal(await session.handleUserMessage('只讨论'), 'completed')
    assert.equal(toolNames(model.doStreamCalls[0]).includes(SKILL_TOOL_NAME), false)
    assert.doesNotMatch(JSON.stringify(model.doStreamCalls[0]?.prompt), /available_skills/)
  })

  it('活动 Skill 本身超过模型任务预算时不发起超限请求', async () => {
    const fixture = await skillFixture()
    const catalog = new SkillCatalogService({ homeDir: fixture.home })
    const listed = await catalog.list(fixture.project, 40_000)
    const { id, path } = listed.skills[0]!
    const selected = await catalog.activate({ id, path }, fixture.project, 40_000)
    selected.content = 'x'.repeat(100_000)
    const model = new MockLanguageModelV4({ doStream: async () => finalStep() })
    const session = createSession(model, fixture, catalog, undefined, 40_000)

    assert.equal(
      await session.handleUserMessage('超限任务', false, [], undefined, [], [selected]),
      'error',
    )
    assert.equal(model.doStreamCalls.length, 0)
  })
})

async function skillFixture() {
  const root = await mkdtemp(join(tmpdir(), 'whycode-agent-skills-'))
  temporaryDirectories.push(root)
  const project = join(root, 'project')
  const home = join(root, 'home')
  const skillRoot = join(project, '.agents', 'skills', 'verify-build')
  await mkdir(join(project, '.git'), { recursive: true })
  await mkdir(skillRoot, { recursive: true })
  await mkdir(join(skillRoot, 'references'), { recursive: true })
  await mkdir(home, { recursive: true })
  await writeFile(join(skillRoot, 'SKILL.md'), [
    '---',
    'name: verify-build',
    'description: 构建并核对结果',
    '---',
    BODY,
  ].join('\n'), 'utf8')
  await writeFile(join(skillRoot, 'references', 'guide.md'), RESOURCE_BODY, 'utf8')
  return { root, project, home }
}

function createSession(
  model: MockLanguageModelV4,
  fixture: { project: string; home: string },
  skillCatalog: SkillCatalogService,
  discussion?: { agentId: 'Main'; scratchDir: string },
  contextWindow = 100_000,
) {
  return new AgentSession({
    model: modelEntry(model, contextWindow),
    providerConfig: { apiKey: 'test' },
    promptContext: {
      projectDir: fixture.project,
      homeDir: fixture.home,
      osPlatform: process.platform,
      discussion,
    },
    skillCatalog,
    emit: () => {},
    requestApproval: async () => ({ approved: false }),
  })
}

function toolStep(skillId: string, resourcePath?: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: 'load-skill',
          toolName: SKILL_TOOL_NAME,
          input: JSON.stringify({ skillId, ...(resourcePath ? { resourcePath } : {}) }),
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
        { type: 'text-delta' as const, id: 'final', delta: '完成' },
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

function toolNames(call: MockLanguageModelV4['doStreamCalls'][number] | undefined): string[] {
  return call?.tools?.map((tool) => tool.name) ?? []
}

function modelEntry(model: MockLanguageModelV4, contextWindow: number): ModelEntry {
  return {
    id: 'test:skills',
    displayName: 'Skills Mock',
    provider: 'openai',
    protocol: 'openai-responses',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: false,
      reasoningExposure: 'none',
      structuredOutput: 'tool-based',
      promptCaching: 'none',
      contextWindow,
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
