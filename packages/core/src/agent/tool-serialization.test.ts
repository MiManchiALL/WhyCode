import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { buildTool } from '../tools/tool.ts'
import { AgentSession } from './session.ts'

describe('工具副作用串行', () => {
  it('同一步的非只读工具不会并发进入执行区', async () => {
    let active = 0
    let maxActive = 0
    const order: string[] = []
    const probe = buildTool({
      name: 'SerialProbe',
      description: '串行探针',
      prompt: '执行串行探针',
      inputSchema: z.object({ value: z.number() }),
      isReadOnly: false,
      kind: 'control',
      async execute({ value }) {
        active++
        maxActive = Math.max(maxActive, active)
        order.push(`start-${value}`)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 40))
        order.push(`end-${value}`)
        active--
        return { data: `ok-${value}`, isError: false }
      },
    })
    const model = new MockLanguageModelV4({ doStream: [parallelToolStep(), finalStep()] })
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
      emit: () => {},
      requestApproval: async () => ({ approved: false }),
    })
    session.setExtraTools([probe])

    await session.handleUserMessage('运行两个探针')

    assert.equal(maxActive, 1)
    assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2'])
  })

  it('独占步骤工具与其它调用不能在同一模型响应中共同执行', async () => {
    for (const order of [
      ['StandaloneProbe', 'NormalProbe'],
      ['NormalProbe', 'StandaloneProbe'],
    ]) {
      const runs: string[] = []
      const events: CoreEvent[] = []
      const standalone = buildTool({
        name: 'StandaloneProbe',
        description: '独占步骤探针',
        prompt: '必须独占步骤',
        inputSchema: z.object({}),
        isReadOnly: false,
        kind: 'control',
        requiresStandaloneStep: true,
        async execute() {
          runs.push('standalone')
          return { data: 'standalone-ok', isError: false }
        },
      })
      const normal = buildTool({
        name: 'NormalProbe',
        description: '普通探针',
        prompt: '普通工具',
        inputSchema: z.object({}),
        isReadOnly: false,
        kind: 'control',
        async execute() {
          runs.push('normal')
          return { data: 'normal-ok', isError: false }
        },
      })
      const model = new MockLanguageModelV4({
        doStream: [namedToolStep(order), finalStep()],
      })
      const session = new AgentSession({
        model: modelEntry(model),
        providerConfig: { apiKey: 'test' },
        promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
        emit: (event) => events.push(event),
        requestApproval: async () => ({ approved: false }),
      })
      session.setExtraTools([standalone, normal])

      assert.equal(await session.handleUserMessage('测试独占边界'), 'completed')
      assert.deepEqual(runs, [order[0] === 'StandaloneProbe' ? 'standalone' : 'normal'])
      assert.equal(
        events.some((event) =>
          event.type === 'tool-end'
          && event.isError
          && String(event.result).includes('必须独占一个模型步骤')),
        true,
      )
    }
  })

  it('同一步的首次隐私审批会合并判定并复用记住的授权', async () => {
    let activeApprovals = 0
    let maxActiveApprovals = 0
    let approvals = 0
    const probe = buildTool({
      name: 'PrivacyProbe',
      description: '隐私审批探针',
      prompt: '执行隐私审批探针',
      inputSchema: z.object({ value: z.number() }),
      isReadOnly: true,
      kind: 'read',
      initialApprovalReason: '需要首次隐私审批',
      async execute({ value }) {
        return { data: `ok-${value}`, isError: false }
      },
    })
    const model = new MockLanguageModelV4({ doStream: [
      parallelToolStep('PrivacyProbe'),
      finalStep(),
    ] })
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
      emit: () => {},
      requestApproval: async () => {
        approvals++
        activeApprovals++
        maxActiveApprovals = Math.max(maxActiveApprovals, activeApprovals)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
        activeApprovals--
        return { approved: true, remember: true }
      },
    })
    session.setExtraTools([probe])

    assert.equal(await session.handleUserMessage('运行两个隐私探针'), 'completed')
    assert.equal(approvals, 1)
    assert.equal(maxActiveApprovals, 1)
  })

  it('同一步多个独立需审批工具合并成一张精确调用清单', async () => {
    const executions: string[] = []
    let approvals = 0
    const first = approvalProbe('BatchApprovalFirst', executions)
    const second = approvalProbe('BatchApprovalSecond', executions)
    const model = new MockLanguageModelV4({
      doStream: [namedToolStep([first.name, second.name]), finalStep()],
    })
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: 'C:\\workspace', osPlatform: 'win32' },
      emit: () => {},
      requestApproval: async (request) => {
        approvals++
        assert.equal(request.toolName, '批量工具操作（2 项）')
        assert.deepEqual(
          request.items?.map((item) => item.toolName),
          [first.name, second.name],
        )
        assert.deepEqual(request.input, [
          { toolName: first.name, input: {} },
          { toolName: second.name, input: {} },
        ])
        assert.equal(request.suggestion, undefined)
        return { approved: true }
      },
    })
    session.setExtraTools([first, second])

    assert.equal(await session.handleUserMessage('同一步运行两个需审批工具'), 'completed')
    assert.equal(approvals, 1)
    assert.deepEqual(executions, [first.name, second.name])
  })

  it('审批等待期间切入只读后会再次按最新档位拒绝，不进入工具执行区', async () => {
    let executions = 0
    let approvals = 0
    const events: CoreEvent[] = []
    const probe = buildTool({
      name: 'PermissionRaceProbe',
      description: '权限切档竞态探针',
      prompt: '执行权限切档竞态探针',
      inputSchema: z.object({}),
      isReadOnly: false,
      kind: 'execute',
      initialApprovalReason: '该工具会启动外部进程',
      async execute() {
        executions++
        return { data: 'executed', isError: false }
      },
    })
    const model = new MockLanguageModelV4({
      doStream: [namedToolStep([probe.name]), finalStep()],
    })
    let session!: AgentSession
    session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: 'C:\\workspace', osPlatform: 'win32' },
      emit: (event) => events.push(event),
      requestApproval: async () => {
        approvals++
        session.setPermissionMode('readonly')
        return { approved: true }
      },
    })
    session.setExtraTools([probe])

    assert.equal(await session.handleUserMessage('运行权限切档探针'), 'completed')
    assert.equal(approvals, 1)
    assert.equal(executions, 0)
    assert.equal(
      events.some((event) =>
        event.type === 'tool-end'
        && event.isError
        && String(event.result).includes('当前为只读模式')),
      true,
    )
  })

  it('默认档的项目外写入由一张路径审批同时覆盖写权限与本次路径', async () => {
    let executions = 0
    let approvals = 0
    const probe = buildTool({
      name: 'OutsideEditProbe',
      description: '项目外写入审批探针',
      prompt: '执行项目外写入审批探针',
      inputSchema: z.object({ path: z.string() }),
      isReadOnly: false,
      kind: 'edit',
      extractPaths: ({ path }) => [path],
      async execute() {
        executions++
        return { data: 'edited', isError: false }
      },
    })
    const model = new MockLanguageModelV4({
      doStream: [
        singleToolStep(probe.name, { path: 'D:\\outside\\result.txt' }),
        finalStep(),
      ],
    })
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: 'C:\\workspace', osPlatform: 'win32' },
      emit: () => {},
      requestApproval: async (request) => {
        approvals++
        assert.match(request.reason, /路径超出项目目录/)
        assert.deepEqual(request.suggestion, {
          kind: 'add-dir',
          dir: 'D:\\outside\\result.txt',
        })
        return { approved: true }
      },
    })
    session.setExtraTools([probe])

    assert.equal(await session.handleUserMessage('写入项目外文件'), 'completed')
    assert.equal(approvals, 1)
    assert.equal(executions, 1)
  })

  it('全自动档的项目外精确路径会传入工具执行边界且不弹审批', async () => {
    const outsidePath = 'D:\\outside\\auto-result.txt'
    let visiblePaths: readonly string[] = []
    let approvals = 0
    const probe = buildTool({
      name: 'AutoOutsideEditProbe',
      description: '全自动项目外路径探针',
      prompt: '全自动项目外路径探针',
      inputSchema: z.object({ path: z.string() }),
      isReadOnly: false,
      kind: 'edit',
      extractPaths: ({ path }) => [path],
      async execute(_input, context) {
        visiblePaths = context.additionalDirs
        return { data: 'edited', isError: false }
      },
    })
    const model = new MockLanguageModelV4({
      doStream: [singleToolStep(probe.name, { path: outsidePath }), finalStep()],
    })
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: 'C:\\workspace', osPlatform: 'win32' },
      emit: () => {},
      requestApproval: async () => {
        approvals++
        return { approved: false }
      },
    })
    session.setExtraTools([probe])
    session.setPermissionMode('auto')

    assert.equal(await session.handleUserMessage('全自动写入项目外文件'), 'completed')
    assert.equal(approvals, 0)
    assert.deepEqual(visiblePaths, [outsidePath])
  })

  it('把 edit/execute 的完整临界区交给宿主调度，control 不越权进入', async () => {
    const scheduled: string[] = []
    const edited = buildTool({
      name: 'HostScheduledEdit',
      description: '宿主调度写操作',
      prompt: '执行宿主调度写操作',
      inputSchema: z.object({ value: z.number().default(1) }),
      isReadOnly: false,
      kind: 'edit',
      async execute({ value }) {
        return { data: `edit-${value}`, isError: false }
      },
    })
    const controlled = buildTool({
      name: 'LocalControl',
      description: '本地控制操作',
      prompt: '执行本地控制操作',
      inputSchema: z.object({ value: z.number().default(1) }),
      isReadOnly: false,
      kind: 'control',
      async execute({ value }) {
        return { data: `control-${value}`, isError: false }
      },
    })
    const model = new MockLanguageModelV4({
      doStream: [
        namedToolStep(['HostScheduledEdit', 'LocalControl']),
        finalStep(),
      ],
    })
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
      emit: () => {},
      requestApproval: async () => ({ approved: true }),
      scheduleProjectMutation: async (mutation, _signal, operation) => {
        if (mutation.type === 'tool') scheduled.push(mutation.name)
        return operation()
      },
    })
    session.setExtraTools([edited, controlled])

    assert.equal(await session.handleUserMessage('运行宿主调度探针'), 'completed')
    assert.deepEqual(scheduled, ['HostScheduledEdit'])
  })

  it('把工具返回的逐文件行统计附加到稳定 tool-end 事件', async () => {
    const events: CoreEvent[] = []
    const probe = buildTool({
      name: 'FileChangeProbe',
      description: '文件统计探针',
      prompt: '返回文件统计',
      inputSchema: z.object({}),
      isReadOnly: true,
      kind: 'read',
      async execute() {
        return {
          data: 'ok',
          isError: false,
          fileChanges: [{ path: 'src/app.ts', added: 2, removed: 1 }],
        }
      },
    })
    const model = new MockLanguageModelV4({
      doStream: [singleToolStep(probe.name, {}), finalStep()],
    })
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: false }),
    })
    session.setExtraTools([probe])

    assert.equal(await session.handleUserMessage('运行文件统计探针'), 'completed')
    assert.deepEqual(events.find((event) => event.type === 'tool-end'), {
      type: 'tool-end',
      toolUseId: 'single-tool',
      result: 'ok',
      isError: false,
      fileChanges: [{ path: 'src/app.ts', added: 2, removed: 1 }],
    })
  })
})

function parallelToolStep(toolName = 'SerialProbe') {
  return {
    stream: simulateReadableStream({
      chunks: [
        toolCall('serial-1', 1, toolName),
        toolCall('serial-2', 2, toolName),
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: usage(),
        },
      ],
    }),
  }
}

function approvalProbe(name: string, executions: string[]) {
  return buildTool({
    name,
    description: `${name} 审批探针`,
    prompt: `${name} 审批探针`,
    inputSchema: z.object({}),
    isReadOnly: false,
    kind: 'execute',
    async execute() {
      executions.push(name)
      return { data: `${name}-ok`, isError: false }
    },
  })
}

function namedToolStep(toolNames: string[]) {
  return {
    stream: simulateReadableStream({
      chunks: [
        ...toolNames.map((toolName, index) => ({
          type: 'tool-call' as const,
          toolCallId: `mixed-${index}`,
          toolName,
          input: '{}',
        })),
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: usage(),
        },
      ],
    }),
  }
}

function singleToolStep(toolName: string, input: Record<string, unknown>) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: 'single-tool',
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

function toolCall(id: string, value: number, toolName: string) {
  return {
    type: 'tool-call' as const,
    toolCallId: id,
    toolName,
    input: JSON.stringify({ value }),
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

function modelEntry(model: MockLanguageModelV4): ModelEntry {
  return {
    id: 'test:serial-tool',
    displayName: 'Serial Tool Mock',
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
