import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { OfficeArtifactRunner, OfficeProcessor } from '../office/types.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import {
  BUILD_OFFICE_ARTIFACT_TOOL_NAME,
  createBuildOfficeArtifactTool,
} from '../tools/build-office-artifact/index.ts'
import {
  createInspectOfficeTool,
  INSPECT_OFFICE_TOOL_NAME,
} from '../tools/inspect-office/index.ts'
import { RENDER_OFFICE_TOOL_NAME } from '../tools/render-office/index.ts'
import { localWorkspace } from '../workspace/types.ts'
import { AgentSession } from './session.ts'

describe('Office Agent 工具装配', () => {
  it('所有模型获得生成与结构检查，只有视觉模型获得后台页面渲染', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-agent-office-'))
    try {
      const projectDir = join(root, 'project')
      await mkdir(projectDir)
      const store = new SessionStore(join(root, 'sessions'))
      const textJournal = await store.create({
        workspace: localWorkspace(projectDir), modelId: 'test:text',
      })
      const visualJournal = await store.create({
        workspace: localWorkspace(projectDir), modelId: 'test:visual',
      })

      await probe(textJournal, projectDir, false, (names) => {
        assert.equal(names.includes(BUILD_OFFICE_ARTIFACT_TOOL_NAME), true)
        assert.equal(names.includes(INSPECT_OFFICE_TOOL_NAME), true)
        assert.equal(names.includes(RENDER_OFFICE_TOOL_NAME), false)
      })
      await probe(visualJournal, projectDir, true, (names) => {
        assert.equal(names.includes(BUILD_OFFICE_ARTIFACT_TOOL_NAME), true)
        assert.equal(names.includes(INSPECT_OFFICE_TOOL_NAME), true)
        assert.equal(names.includes(RENDER_OFFICE_TOOL_NAME), true)
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('讨论 Agent 不获得 Office 项目工具', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-agent-office-discussion-'))
    try {
      const projectDir = join(root, 'project')
      const scratchDir = join(root, 'scratch')
      await Promise.all([mkdir(projectDir), mkdir(scratchDir)])
      const journal = await new SessionStore(join(root, 'sessions')).create({
        workspace: localWorkspace(projectDir), modelId: 'test:visual',
      })
      const model = probingModel((names) => {
        assert.equal(names.includes(BUILD_OFFICE_ARTIFACT_TOOL_NAME), false)
        assert.equal(names.includes(INSPECT_OFFICE_TOOL_NAME), false)
        assert.equal(names.includes(RENDER_OFFICE_TOOL_NAME), false)
      })
      const session = new AgentSession({
        model: modelEntry(model, true),
        providerConfig: { apiKey: 'test' },
        promptContext: {
          projectDir,
          osPlatform: 'win32',
          discussion: { agentId: 'B', scratchDir },
        },
        sessionRecorder: journal,
        officeProcessor,
        mainTools: mainTools(),
        emit: () => {},
        requestApproval: async () => ({ approved: false }),
      })
      assert.equal(await session.handleUserMessage('讨论 Office'), 'completed')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function probe(
  journal: Awaited<ReturnType<SessionStore['create']>>,
  projectDir: string,
  supportsImages: boolean,
  assertNames: (names: string[]) => void,
): Promise<void> {
  const model = probingModel(assertNames)
  const session = new AgentSession({
    model: modelEntry(model, supportsImages),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir, osPlatform: 'win32' },
    sessionRecorder: journal,
    officeProcessor,
    mainTools: mainTools(),
    emit: () => {},
    requestApproval: async () => ({ approved: false }),
  })
  assert.equal(await session.handleUserMessage('处理 Office'), 'completed')
}

function mainTools() {
  const runner: OfficeArtifactRunner = {
    async build() {
      throw new Error('unexpected build')
    },
  }
  return [
    createBuildOfficeArtifactTool(runner),
    createInspectOfficeTool(officeProcessor),
  ]
}

const officeProcessor: OfficeProcessor = {
  async inspect() {
    throw new Error('unexpected inspect')
  },
  async renderPages() {
    throw new Error('unexpected render')
  },
}

function probingModel(assertNames: (names: string[]) => void): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (options) => {
      assertNames(options.tools?.map((tool) => tool.name) ?? [])
      return finalStep()
    },
  })
}

function modelEntry(model: MockLanguageModelV4, supportsImageInput: boolean): ModelEntry {
  return {
    id: supportsImageInput ? 'test:visual' : 'test:text',
    displayName: 'Office Mock',
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

function finalStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'text-1' },
        { type: 'text-delta' as const, id: 'text-1', delta: '完成' },
        { type: 'text-end' as const, id: 'text-1' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          },
        },
      ],
    }),
  }
}
