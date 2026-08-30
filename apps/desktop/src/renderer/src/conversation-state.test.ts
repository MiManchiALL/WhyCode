import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ViewEvent } from '@whycode/core'
import { MAX_VISIBLE_TOOL_OUTPUT_CHARS } from '@whycode/core/events'
import {
  applyCoreEvent,
  applyViewEvent,
  appendUserMessage,
  checkpointRestoreAnchorIds,
  type ConversationState,
  createConversationState,
  editableUserBlockId,
  runtimeEventsAfterSnapshot,
  resumeTargetCommitted,
  toggleExpanded,
} from './conversation-state.ts'
import { conversationSections } from './conversation-sections.ts'

describe('会话界面时间线重建', () => {
  it('实时工具进度始终保持有界，不把长命令输出带入切换快照', () => {
    let state = createConversationState([
      { type: 'user-message', text: '运行长命令', startsTurn: true },
      core({
        type: 'tool-start',
        toolUseId: 'run-1',
        toolName: 'RunCommand',
        input: {},
      }),
    ])
    state = applyCoreEvent(state, {
      type: 'tool-progress',
      toolUseId: 'run-1',
      output: 'x'.repeat(MAX_VISIBLE_TOOL_OUTPUT_CHARS + 10),
    })
    state = applyCoreEvent(state, {
      type: 'tool-progress',
      toolUseId: 'run-1',
      output: '最新尾部',
    })

    const tool = state.blocks.find((block) => block.kind === 'tool')
    assert.ok(tool?.kind === 'tool')
    assert.ok(tool.call.progress.length <= MAX_VISIBLE_TOOL_OUTPUT_CHARS)
    assert.match(tool.call.progress, /最新尾部$/u)
  })

  it('实时步骤丢弃时撤销协议文本，重试答复提交后只保留稳定内容', () => {
    let state = createConversationState([
      { type: 'user-message', text: '统计代码行数', startsTurn: true },
      core({
        type: 'tool-start',
        toolUseId: 'run-1',
        toolName: 'RunCommand',
        input: { command: 'count' },
      }),
      core({
        type: 'tool-end',
        toolUseId: 'run-1',
        result: '48242',
        isError: false,
      }),
    ])
    const stableBlocks = state.blocks

    state = applyCoreEvent(state, {
      type: 'text-delta',
      text: 'out:default_api:RunCommand{result:"Total: 48242\\n"}',
    })
    assert.equal(state.blocks.length, stableBlocks.length + 1)
    const stableToolId = stableBlocks.find((block) => block.kind === 'tool')!.id
    state = toggleExpanded(state, stableToolId)

    state = applyCoreEvent(state, { type: 'step-discarded' })
    assert.deepEqual(state.blocks, stableBlocks)
    assert.equal(state.expanded.has(stableToolId), true)

    state = applyCoreEvent(state, {
      type: 'text-delta',
      text: '当前受版本控制的代码共 48,242 行。',
    })
    state = applyCoreEvent(state, { type: 'step-committed' })

    assert.equal(state.pendingStep, null)
    const finalBlock = state.blocks.at(-1)
    assert.equal(finalBlock?.kind, 'text')
    assert.equal(
      finalBlock?.kind === 'text' ? finalBlock.text : null,
      '当前受版本控制的代码共 48,242 行。',
    )
    assert.equal(finalBlock?.kind === 'text' ? finalBlock.phase : null, 'final')
    assert.doesNotMatch(JSON.stringify(state.blocks), /out:default_api/)
  })

  it('中途正文与同一步工具始终属于展开过程，纯文本 step 提交后才收起最终回答', () => {
    let state = createConversationState([
      { type: 'user-message', text: '汇总四个项目', startsTurn: true },
    ])
    state = applyCoreEvent(state, { type: 'thinking-delta', text: '读取源码' })
    state = applyCoreEvent(state, { type: 'thinking-end', durationMs: 500 })
    state = applyCoreEvent(state, { type: 'text-delta', text: '以下是完整汇总。' })

    const pendingText = state.blocks.at(-1)
    assert.equal(pendingText?.kind === 'text' ? pendingText.phase : null, 'pending')
    assert.equal(conversationSections(state.blocks, 1_000).some((section) =>
      section.kind === 'active-work'), false)

    state = applyCoreEvent(state, {
      type: 'tool-start',
      toolUseId: 'close-plan',
      toolName: 'CloseTaskPlan',
      input: {},
    })
    state = applyCoreEvent(state, {
      type: 'tool-end',
      toolUseId: 'close-plan',
      result: 'ok',
      isError: false,
    })
    state = applyCoreEvent(state, { type: 'step-committed' })

    const interimText = state.blocks.find((block) => block.kind === 'text')
    assert.equal(interimText?.kind === 'text' ? interimText.phase : null, 'activity')
    assert.equal(conversationSections(state.blocks, 1_000).some((section) =>
      section.kind === 'active-work'), false)

    state = applyCoreEvent(state, { type: 'text-delta', text: '核心结论如下。' })
    state = applyCoreEvent(state, { type: 'step-committed' })

    const sections = conversationSections(state.blocks, 1_000)
    assert.equal(sections.length, 1)
    const active = sections[0]
    assert.equal(active?.kind, 'active-work')
    assert.deepEqual(
      active?.kind === 'active-work'
        ? active.activityBlocks.filter((block) => block.kind === 'text').map((block) => block.text)
        : [],
      ['以下是完整汇总。'],
    )
    assert.deepEqual(
      active?.kind === 'active-work'
        ? active.finalBlocks.filter((block) => block.kind === 'text').map((block) => block.text)
        : [],
      ['核心结论如下。'],
    )
  })

  it('历史重放在 work-finished 边界得到与实时 step 分类相同的最终回答', () => {
    const state = createConversationState([
      { type: 'user-message', text: '检查并汇总', startsTurn: true },
      core({ type: 'text-delta', text: '先给阶段汇总。' }),
      core({
        type: 'tool-start',
        toolUseId: 'verify',
        toolName: 'ReadFile',
        input: { path: 'README.md' },
      }),
      core({ type: 'tool-end', toolUseId: 'verify', result: 'ok', isError: false }),
      core({ type: 'text-delta', text: '最终结论。' }),
      core({
        type: 'work-finished', durationMs: 1_500, outcome: 'completed', forkTurnId: null,
      }),
    ])

    const texts = state.blocks.filter((block) => block.kind === 'text')
    assert.deepEqual(texts.map((block) => [block.text, block.phase]), [
      ['先给阶段汇总。', 'activity'],
      ['最终结论。', 'final'],
    ])
  })

  it('后续任务完成时不覆盖上一轮最终回答的完成时间', () => {
    const state = createConversationState([
      { type: 'user-message', text: '第一问', startsTurn: true },
      core({ type: 'text-delta', text: '第一答' }),
      core({ type: 'work-finished', durationMs: 500, outcome: 'completed', forkTurnId: null }),
      { type: 'user-message', text: '第二问', startsTurn: true },
      core({ type: 'text-delta', text: '第二答' }),
      core({ type: 'work-finished', durationMs: 700, outcome: 'completed', forkTurnId: null }),
    ], [
      '2026-08-09T01:00:00.000Z',
      '2026-08-09T01:00:01.000Z',
      '2026-08-09T01:00:02.000Z',
      '2026-08-09T02:00:00.000Z',
      '2026-08-09T02:00:01.000Z',
      '2026-08-09T02:00:02.000Z',
    ])

    const answers = state.blocks.filter((block) => block.kind === 'text')
    assert.deepEqual(answers.map((block) => [block.text, block.timestamp]), [
      ['第一答', '2026-08-09T01:00:02.000Z'],
      ['第二答', '2026-08-09T02:00:02.000Z'],
    ])
  })

  it('用户停止时保留当前步骤正文，但撤销同一步的推理和工具', () => {
    let state = createConversationState([
      { type: 'user-message', text: '解释这段代码', startsTurn: true },
    ])
    state = applyCoreEvent(state, { type: 'thinking-delta', text: '分析中' })
    state = applyCoreEvent(state, {
      type: 'tool-start',
      toolUseId: 'tool-1',
      toolName: 'ReadFile',
      input: { path: 'sample.ts' },
    })
    state = applyCoreEvent(state, { type: 'text-delta', text: '已经输出的部分' })

    state = applyCoreEvent(state, { type: 'step-output-retained' })
    state = applyCoreEvent(state, { type: 'step-discarded' })

    assert.deepEqual(state.blocks.map((block) => block.kind), ['user', 'text'])
    const output = state.blocks.at(-1)
    assert.equal(output?.kind === 'text' ? output.text : '', '已经输出的部分')
    assert.equal(output?.kind === 'text' ? output.phase : null, 'activity')
    assert.equal(state.pendingStep, null)
  })

  it('Renderer 初始化只接续快照边界之后的实时事件', () => {
    const events = runtimeEventsAfterSnapshot([
      { sequence: 10, event: { type: 'text-delta', text: '已包含在快照中' } },
      { sequence: 11, event: { type: 'text-delta', text: '快照之后的新内容' } },
    ], 10)

    assert.deepEqual(events, [{
      sequence: 11,
      event: { type: 'text-delta', text: '快照之后的新内容' },
    }])
  })

  it('切换或重连会话时只重建真实时间线，不合成恢复提示', () => {
    const state = createConversationState([
      { type: 'user-message', text: '继续之前的问题', startsTurn: true },
      core({ type: 'text-delta', text: '这是已经提交的回答。' }),
    ])

    assert.deepEqual(state.blocks.map((block) => block.kind), ['user', 'text'])
    assert.doesNotMatch(
      JSON.stringify(state.blocks),
      /已恢复|界面已重新连接当前任务|会话恢复已完成/,
    )
  })

  it('完成后的工作时长作为可见事实随历史恢复', () => {
    const state = createConversationState([
      core({
        type: 'work-finished', durationMs: 61_000, outcome: 'completed', forkTurnId: null,
      }),
    ])

    assert.deepEqual(state.blocks, [{
      kind: 'work-duration',
      id: 'b0',
      forkTurnId: null,
      durationMs: 61_000,
      outcome: 'completed',
    }])
  })

  it('完成边界直接提供 Core 验证过的 Fork turn', () => {
    const state = createConversationState([
      { type: 'user-message', text: '执行任务', startsTurn: true },
      core({ type: 'turn-start', turnId: 'turn-main' }),
      core({ type: 'text-delta', text: '阶段进展' }),
      core({ type: 'turn-start', turnId: 'turn-final' }),
      core({ type: 'text-delta', text: '最终结果' }),
      core({
        type: 'work-finished',
        durationMs: 2_000,
        outcome: 'completed',
        forkTurnId: 'turn-final',
      }),
    ])

    const duration = state.blocks.find((block) => block.kind === 'work-duration')
    assert.equal(duration?.kind === 'work-duration' ? duration.forkTurnId : null, 'turn-final')
  })

  it('用户停止时沿用停止瞬间的工作区展开状态', () => {
    let state = createConversationState([
      { type: 'user-message', text: '检查项目', startsTurn: true },
      core({
        type: 'tool-start',
        toolUseId: 'tool-1',
        toolName: 'ReadFile',
        input: { path: 'README.md' },
      }),
      core({ type: 'tool-end', toolUseId: 'tool-1', result: 'ok', isError: false }),
      core({
        type: 'work-finished', durationMs: 1_500, outcome: 'stopped', forkTurnId: null,
      }),
    ])

    assert.equal(state.expanded.has('work-b0'), true)
    state = toggleExpanded(state, 'work-b0')
    assert.equal(state.expanded.has('work-b0'), false)

    const startStreamingFinal = () => {
      let current = createConversationState([
        { type: 'user-message', text: '检查项目', startsTurn: true },
      ])
      current = applyCoreEvent(current, { type: 'thinking-delta', text: '分析' })
      current = applyCoreEvent(current, { type: 'thinking-end', durationMs: 500 })
      return applyCoreEvent(current, { type: 'text-delta', text: '正在输出最终回答' })
    }
    const stop = (current: ConversationState) => {
      current = applyCoreEvent(current, { type: 'step-output-retained' })
      current = applyCoreEvent(current, { type: 'step-discarded' })
      return applyCoreEvent(current, {
        type: 'work-finished',
        durationMs: 1_500,
        outcome: 'stopped',
        forkTurnId: null,
      })
    }

    const streamingFinal = stop(startStreamingFinal())
    assert.equal(streamingFinal.expanded.has('work-b0'), false)
    assert.equal(
      streamingFinal.blocks.find((block) => block.kind === 'text')?.phase,
      'final',
    )

    let manuallyExpanded = startStreamingFinal()
    manuallyExpanded = toggleExpanded(manuallyExpanded, 'work-b0')
    manuallyExpanded = stop(manuallyExpanded)
    assert.equal(manuallyExpanded.expanded.has('work-b0'), true)
  })

  it('提问工具结束当前 turn 时保持处理过程展开', () => {
    const question = {
      id: 'question-waiting',
      questions: [{
        header: '实现偏好',
        question: '你更看重哪一点？',
        options: [
          { label: '简单可靠', description: '减少复杂度' },
          { label: '功能完整', description: '覆盖更多场景' },
        ],
      }, {
        header: '提交范围',
        question: '是否包含测试？',
        options: [
          { label: '包含测试', description: '一起验证行为' },
          { label: '只改实现', description: '暂不调整测试' },
        ],
      }],
    }
    let state = createConversationState([{
      type: 'user-message',
      text: '完成这个任务',
      startsTurn: true,
    }])
    state = applyCoreEvent(state, { type: 'thinking-delta', text: '先检查现状' })
    state = applyCoreEvent(state, { type: 'thinking-end', durationMs: 500 })
    state = applyCoreEvent(state, {
      type: 'tool-start',
      toolUseId: 'ask-1',
      toolName: 'AskUserQuestion',
      input: { questions: question.questions },
    })
    state = applyCoreEvent(state, {
      type: 'tool-end',
      toolUseId: 'ask-1',
      result: '等待用户回答',
      isError: false,
    })
    state = applyCoreEvent(state, { type: 'user-question', question })
    state = applyCoreEvent(state, { type: 'step-committed' })
    state = applyCoreEvent(state, {
      type: 'work-finished',
      durationMs: 1_500,
      outcome: 'completed',
      forkTurnId: null,
    })

    const completed = conversationSections(state.blocks)[0]
    assert.equal(completed?.kind, 'completed-work')
    assert.equal(state.expanded.has('work-b0'), true)
    assert.equal(
      completed?.kind === 'completed-work' ? completed.finalBlocks.length : -1,
      0,
    )
    assert.deepEqual(state.pendingQuestion, question)

    state = appendUserMessage(
      state,
      '1. 回答「你更看重哪一点？」：简单可靠\n2. 回答「是否包含测试？」：包含测试',
      true,
    )
    const askTool = state.blocks.find((block) =>
      block.kind === 'tool' && block.call.id === 'ask-1')
    assert.equal(
      askTool?.kind === 'tool' ? askTool.call.result : null,
      [
        'Question: 你更看重哪一点？',
        'Answer: 简单可靠',
        '',
        'Question: 是否包含测试？',
        'Answer: 包含测试',
      ].join('\n'),
    )
  })

  it('CloseTaskPlan 卡片保留调用当时的活动计划 ID', () => {
    let state = createConversationState()
    state = applyCoreEvent(state, { type: 'task-plan-updated', plan: taskPlan(1) })
    state = applyCoreEvent(state, {
      type: 'tool-start',
      toolUseId: 'close-plan-id',
      toolName: 'CloseTaskPlan',
      input: {},
    })
    const tool = state.blocks.find((block) => block.kind === 'tool')
    assert.deepEqual(tool?.kind === 'tool' ? tool.call.input : null, {
      plan_id: '11111111-1111-4111-8111-111111111111',
    })
  })

  it('显式 Skill 摘要随根消息和插话进入可见时间线', () => {
    const skill = {
      id: `skill:${'a'.repeat(64)}`,
      path: 'C:/project/.agents/skills/verify/SKILL.md',
      rootPath: 'C:/project/.agents/skills/verify',
      name: 'verify',
      description: '验证结果',
      scope: 'project' as const,
    }
    let state = createConversationState([{
      type: 'user-message',
      inputId: 'root-skill',
      text: '执行验证',
      startsTurn: true,
      skills: [skill],
    }])
    state = applyCoreEvent(state, {
      type: 'message-injected',
      id: 'steering-skill',
      text: '补充核对',
      skills: [{ ...skill, scope: 'user' }],
    })

    const users = state.blocks.filter((block) => block.kind === 'user')
    assert.deepEqual(users.map((block) => block.skills?.[0]?.name), ['verify', 'verify'])
    assert.equal(users[0]?.kind === 'user' ? users[0].skills?.[0]?.scope : null, 'project')
    assert.equal(users[1]?.kind === 'user' ? users[1].skills?.[0]?.scope : null, 'user')
  })

  it('Renderer 重载后只应用 Main 已原子提交的恢复目标', () => {
    assert.equal(resumeTargetCommitted({
      resumingSessionId: 'target',
      sessionId: 'current',
    }, 'target'), false)
    assert.equal(resumeTargetCommitted({
      resumingSessionId: null,
      sessionId: 'target',
    }, 'target'), true)
    assert.equal(resumeTargetCommitted({
      resumingSessionId: null,
      sessionId: 'current',
    }, 'target'), false)
  })

  it('按原顺序恢复用户、推理、工具、候选和 B/C 卡片', () => {
    const state = createConversationState([
      { type: 'user-message', text: '分析项目', startsTurn: true },
      core({ type: 'turn-start', turnId: 'turn-1' }),
      core({ type: 'thinking-delta', text: '先查看结构' }),
      core({ type: 'thinking-end', durationMs: 1200 }),
      core({ type: 'tool-start', toolUseId: 'tool-1', toolName: 'ListDir', input: { path: '.' } }),
      core({ type: 'tool-end', toolUseId: 'tool-1', result: 'app\nREADME.md', isError: false }),
      core({
        type: 'candidate-submitted',
        agentId: 'Main',
        candidateId: 'M1',
        summary: '这是一个桌面 Agent 项目',
      }),
      core({
        type: 'peer-event',
        agentId: 'B',
        event: { type: 'text-delta', text: 'B 的独立分析' },
      }),
      core({
        type: 'vote-cast',
        from: 'B',
        target: 'M1',
        vote: 'accept',
        reason: '结论正确',
      }),
      core({ type: 'text-delta', text: '最终回答' }),
    ])

    assert.deepEqual(state.blocks.map((block) => block.kind), [
      'user',
      'thinking',
      'tool',
      'candidate',
      'peer',
      'text',
    ])
    assert.equal(state.blocks.find((block) => block.kind === 'tool')?.call.status, 'done')
    const peer = state.blocks.find((block) => block.kind === 'peer')
    assert.equal(peer?.kind === 'peer' ? peer.peer.status : null, 'done')
    assert.match(JSON.stringify(state.blocks), /B 的独立分析/)
  })

  it('重放文件和对话回滚时删除对应 turn 的可见内容', () => {
    const state = createConversationState([
      { type: 'user-message', text: '保留的旧问题', startsTurn: true },
      core({ type: 'turn-start', turnId: 'turn-old' }),
      core({ type: 'text-delta', text: '旧回答' }),
      { type: 'user-message', text: '需要回滚的问题', startsTurn: true },
      core({ type: 'turn-start', turnId: 'turn-new' }),
      core({ type: 'tool-start', toolUseId: 'tool-2', toolName: 'EditFile', input: {} }),
      core({ type: 'tool-end', toolUseId: 'tool-2', result: 'ok', isError: false }),
      core({
        type: 'checkpoint-restored',
        toolUseId: 'tool-2',
        turnId: 'turn-new',
        scope: 'files-and-chat',
        ok: true,
      }),
    ])

    assert.match(JSON.stringify(state.blocks), /保留的旧问题/)
    assert.doesNotMatch(JSON.stringify(state.blocks), /需要回滚的问题/)
    assert.match(JSON.stringify(state.blocks), /已回滚/)
  })

  it('主进程确认的新根消息建立唯一回滚锚点，随后排队插话不覆盖它', () => {
    let state = createConversationState([
      { type: 'user-message', text: '保留的旧问题', startsTurn: true },
      core({ type: 'turn-start', turnId: 'turn-old' }),
      core({ type: 'text-delta', text: '保留的旧回答' }),
    ])
    state = applyCoreEvent(state, {
      type: 'user-message-accepted',
      inputId: 'root-new',
      text: '新的根消息',
      startsTurn: true,
    })
    state = applyCoreEvent(state, { type: 'turn-start', turnId: 'turn-new' })
    state = applyCoreEvent(state, {
      type: 'message-injected',
      id: 'steering-1',
      text: '运行中的补充要求',
      startsTurn: false,
    })
    state = applyCoreEvent(state, { type: 'text-delta', text: '新回答' })
    state = applyCoreEvent(state, {
      type: 'checkpoint-restored',
      toolUseId: 'tool-new',
      turnId: 'turn-new',
      scope: 'files-and-chat',
      ok: true,
    })

    const serialized = JSON.stringify(state.blocks)
    assert.match(serialized, /保留的旧问题/)
    assert.match(serialized, /保留的旧回答/)
    assert.doesNotMatch(serialized, /新的根消息/)
    assert.doesNotMatch(serialized, /运行中的补充要求/)
    assert.doesNotMatch(serialized, /新回答/)
  })

  it('实时编辑把最新根消息留在原位置，并让新 turn 复用该锚点', () => {
    let state = createConversationState([
      { type: 'user-message', inputId: 'old-input', text: '旧问题', startsTurn: true },
      core({ type: 'turn-start', turnId: 'turn-old' }),
      core({
        type: 'work-finished', durationMs: 1_500, outcome: 'stopped', forkTurnId: null,
      }),
    ])

    state = applyCoreEvent(state, {
      type: 'user-message-edited',
      previousTurnId: 'turn-old',
      inputId: 'edited-input',
      text: '编辑后的问题',
      taskPlan: null,
    })
    assert.deepEqual(state.blocks.map((block) => block.kind), ['user'])
    assert.equal(state.blocks[0]?.kind === 'user' && state.blocks[0].text, '编辑后的问题')
    assert.equal(state.blocks[0]?.kind === 'user' && state.blocks[0].turnId, undefined)

    state = applyCoreEvent(state, { type: 'turn-start', turnId: 'turn-edited' })
    assert.equal(state.blocks[0]?.kind === 'user' && state.blocks[0].turnId, 'turn-edited')
  })

  it('根消息显示发送时间，完整回答显示工作完成时间，编辑后改用新发送时间', () => {
    const inputAt = '2026-08-08T10:00:00.000Z'
    const turnAt = '2026-08-08T10:00:01.000Z'
    const textAt = '2026-08-08T10:00:02.000Z'
    const finishedAt = '2026-08-08T10:00:03.000Z'
    const editedAt = '2026-08-08T10:05:00.000Z'
    let state = createConversationState([
      { type: 'user-message', inputId: 'input-1', text: '旧问题', startsTurn: true },
      core({ type: 'turn-start', turnId: 'turn-1' }),
      core({ type: 'text-delta', text: '完整回答' }),
      core({
        type: 'work-finished', durationMs: 2_000, outcome: 'completed', forkTurnId: 'turn-1',
      }),
    ], [inputAt, turnAt, textAt, finishedAt])

    assert.equal(state.blocks[0]?.kind === 'user' && state.blocks[0].timestamp, inputAt)
    assert.equal(state.blocks[1]?.kind === 'text' && state.blocks[1].timestamp, finishedAt)

    state = applyCoreEvent(state, {
      type: 'user-message-edited',
      previousTurnId: 'turn-1',
      inputId: 'input-2',
      text: '编辑后的问题',
      taskPlan: null,
    }, editedAt)
    assert.deepEqual(state.blocks.map((block) => block.kind), ['user'])
    assert.equal(state.blocks[0]?.kind === 'user' && state.blocks[0].timestamp, editedAt)
  })

  it('最新根消息在有完整回答或停止输出后仍保持编辑资格', () => {
    let state = applyCoreEvent(
      applyCoreEvent(
        createConversationState(),
        { type: 'user-message-accepted', inputId: 'input-1', text: '旧消息', startsTurn: true },
      ),
      { type: 'turn-start', turnId: 'turn-1' },
    )

    assert.equal(editableUserBlockId(state.blocks), state.blocks[0]?.id)
    state = applyCoreEvent(state, {
      type: 'work-finished',
      durationMs: 1000,
      outcome: 'completed',
      forkTurnId: 'turn-1',
    })
    assert.equal(editableUserBlockId(state.blocks), state.blocks[0]?.id)
    state = applyCoreEvent(state, { type: 'text-delta', text: '已有输出' })
    assert.equal(editableUserBlockId(state.blocks), state.blocks[0]?.id)

    state = applyCoreEvent(state, {
      type: 'message-injected',
      id: 'steering-2',
      text: '后续用户消息',
      startsTurn: false,
    })
    assert.equal(editableUserBlockId(state.blocks), null)
  })

  it('重放中的编辑输入副本与实时编辑事件走同一 reducer 且不重复显示', () => {
    const state = createConversationState([
      { type: 'user-message', inputId: 'old-input', text: '旧问题', startsTurn: true },
      core({ type: 'turn-start', turnId: 'turn-old' }),
      core({ type: 'work-finished', durationMs: 800, outcome: 'stopped', forkTurnId: null }),
      { type: 'user-message', inputId: 'edited-input', text: '编辑后的问题', startsTurn: true },
      core({
        type: 'user-message-edited',
        previousTurnId: 'turn-old',
        inputId: 'edited-input',
        text: '编辑后的问题',
        taskPlan: null,
      }),
      core({ type: 'turn-start', turnId: 'turn-edited' }),
    ])

    assert.equal(state.blocks.length, 1)
    assert.equal(state.blocks[0]?.kind === 'user' && state.blocks[0].text, '编辑后的问题')
    assert.equal(state.blocks[0]?.kind === 'user' && state.blocks[0].turnId, 'turn-edited')
  })

  it('重放时忽略 partial 覆盖，并在恢复后清除精确检查点按钮', () => {
    const state = createConversationState([
      core({ type: 'tool-start', toolUseId: 'tool-1', toolName: 'RunCommand', input: {} }),
      core({
        type: 'checkpoint-created',
        toolUseId: 'tool-1',
        hash: 'checkpoint-1',
        coverage: 'partial',
        warning: '只覆盖工作区文件',
      }),
      core({ type: 'tool-end', toolUseId: 'tool-1', result: 'ok', isError: false }),
      core({ type: 'tool-start', toolUseId: 'tool-2', toolName: 'EditFile', input: {} }),
      core({
        type: 'checkpoint-created',
        toolUseId: 'tool-2',
        hash: 'checkpoint-2',
        coverage: 'complete',
      }),
      core({ type: 'tool-end', toolUseId: 'tool-2', result: 'ok', isError: false }),
      core({
        type: 'checkpoint-restored',
        toolUseId: 'tool-2',
        turnId: 'turn-1',
        scope: 'files',
        ok: true,
        invalidatedToolUseIds: ['tool-2'],
      }),
    ])

    const tools = state.blocks.filter((block) => block.kind === 'tool')
    assert.equal(tools[0]?.kind === 'tool' ? tools[0].call.hasCheckpoint : null, undefined)
    assert.equal(tools[1]?.kind === 'tool' ? tools[1].call.hasCheckpoint : null, false)
    assert.match(JSON.stringify(state.blocks), /已回滚检查点覆盖的文件/)
  })

  it('同一轮多个文件检查点只把首个工具投影为回滚入口', () => {
    const state = createConversationState([
      { type: 'user-message', text: '新建 A、B、C', startsTurn: true },
      core({ type: 'turn-start', turnId: 'turn-files' }),
      ...checkpointEvents('tool-a', 'A'),
      ...checkpointEvents('tool-b', 'B'),
      ...checkpointEvents('tool-c', 'C'),
    ])

    assert.deepEqual([...checkpointRestoreAnchorIds(state)], ['tool-a'])
    const tools = state.blocks.filter((block) => block.kind === 'tool')
    assert.equal(tools.every((block) => block.call.hasCheckpoint), true)
  })

  it('每轮各自保留一个回滚入口，检查点失效后实时与重放投影一致', () => {
    const events: ViewEvent[] = [
      { type: 'user-message', text: '第一轮', startsTurn: true },
      core({ type: 'turn-start', turnId: 'turn-1' }),
      ...checkpointEvents('tool-a', 'A'),
      ...checkpointEvents('tool-b', 'B'),
      { type: 'user-message', text: '第二轮', startsTurn: true },
      core({ type: 'turn-start', turnId: 'turn-2' }),
      ...checkpointEvents('tool-c', 'C'),
      core({
        type: 'checkpoint-restored',
        toolUseId: 'tool-c',
        turnId: 'turn-2',
        scope: 'files',
        ok: true,
        invalidatedToolUseIds: ['tool-c'],
      }),
    ]
    const replayed = createConversationState(events)
    let live = createConversationState()
    for (const event of events) {
      live = event.type === 'core-event'
        ? applyCoreEvent(live, event.event)
        : applyViewEvent(live, event)
    }

    assert.deepEqual([...checkpointRestoreAnchorIds(replayed)], ['tool-a'])
    assert.deepEqual(
      [...checkpointRestoreAnchorIds(live)],
      [...checkpointRestoreAnchorIds(replayed)],
    )
  })

  it('恢复结构化任务计划，并在文件和对话回滚时同步恢复计划状态', () => {
    const active = taskPlan(1)
    const advanced = taskPlan(2)
    const state = createConversationState([
      core({ type: 'task-plan-updated', plan: active }),
      { type: 'user-message', text: '推进计划', startsTurn: true },
      core({ type: 'turn-start', turnId: 'turn-plan' }),
      core({ type: 'task-plan-updated', plan: advanced }),
      core({
        type: 'checkpoint-restored',
        toolUseId: 'tool-plan',
        turnId: 'turn-plan',
        scope: 'files-and-chat',
        ok: true,
        taskPlan: active,
      }),
    ])

    assert.deepEqual(state.taskPlan, active)
    assert.doesNotMatch(JSON.stringify(state.blocks), /推进计划/)
  })

  it('恢复结束旧计划和创建新计划时只投影最新计划，不生成历史块', () => {
    const previousActive = taskPlan(1)
    const next = { ...taskPlan(1), id: '22222222-2222-4222-8222-222222222222', goal: '开发 CSGO' }
    const state = createConversationState([
      core({
        type: 'task-plan-updated',
        plan: {
        ...previousActive,
          status: 'ended',
          revision: previousActive.revision + 1,
        },
      }),
      core({ type: 'task-plan-updated', plan: next }),
    ])

    assert.deepEqual(state.taskPlan, next)
    assert.doesNotMatch(JSON.stringify(state.blocks), /plan-replaced|用户明确切换游戏/)
  })

  it('恢复待回答问题，并在下一条用户消息出现后清除等待卡', () => {
    const question = {
      id: 'question-1',
      questions: [{
        header: '实现偏好',
        question: '你更看重哪一点？',
        options: [
          { label: '简单可靠', description: '减少复杂度' },
          { label: '功能完整', description: '覆盖更多场景' },
        ],
      }],
    }
    const waiting = createConversationState([core({ type: 'user-question', question })])
    assert.deepEqual(waiting.pendingQuestion, question)

    const answered = createConversationState([
      core({ type: 'user-question', question }),
      { type: 'user-message', text: '选择简单可靠', startsTurn: true },
    ])
    assert.equal(answered.pendingQuestion, null)

    const restored = createConversationState([
      core({ type: 'user-question', question }),
      { type: 'user-message', text: '选择简单可靠', startsTurn: true },
      core({
        type: 'checkpoint-restored',
        toolUseId: 'tool-after-answer',
        turnId: 'turn-after-answer',
        scope: 'files-and-chat',
        ok: true,
        question,
      }),
    ])
    assert.deepEqual(restored.pendingQuestion, question)
  })

  it('恢复图片缩略图元数据，并明确显示本轮跳过协商', () => {
    const state = createConversationState([
      {
        type: 'user-message',
        text: '',
        startsTurn: true,
        attachments: [{
          id: '22222222-2222-4222-8222-222222222222',
          sessionId: '11111111-1111-4111-8111-111111111111',
          name: 'screen.png',
          storageName: '22222222-2222-4222-8222-222222222222.png',
          mediaType: 'image/png',
          byteLength: 68,
          width: 1,
          height: 1,
        }],
      },
      core({ type: 'consensus-skipped', reason: 'image-input' }),
    ])

    assert.equal(state.blocks[0]?.kind, 'user')
    assert.equal(state.blocks[0]?.kind === 'user' ? state.blocks[0].text : null, '')
    assert.equal(state.blocks[0]?.kind === 'user' ? state.blocks[0].attachments?.[0]?.name : '', 'screen.png')
    assert.match(
      state.blocks[1]?.kind === 'notice' ? state.blocks[1].text : '',
      /仅由当前视觉模型处理|跳过协商/,
    )
  })

  it('恢复 PDF 卡片元数据，并明确显示 Main-only 边界', () => {
    const state = createConversationState([{
      type: 'user-message',
      text: '总结 PDF',
      startsTurn: true,
      pdfAttachments: [{
        id: '22222222-2222-4222-8222-222222222222',
        sessionId: '11111111-1111-4111-8111-111111111111',
        name: 'guide.pdf',
        storageName: '22222222-2222-4222-8222-222222222222.pdf',
        mediaType: 'application/pdf',
        sha256: 'a'.repeat(64),
        byteLength: 123,
        pageCount: 7,
      }],
    }, core({ type: 'consensus-skipped', reason: 'pdf-input' })])

    assert.equal(
      state.blocks[0]?.kind === 'user'
        ? state.blocks[0].pdfAttachments?.[0]?.name
        : '',
      'guide.pdf',
    )
    assert.match(
      state.blocks[1]?.kind === 'notice' ? state.blocks[1].text : '',
      /仅由 Main 读取|跳过协商/,
    )
  })

  it('把 ViewImage 读取结果恢复到对应工具卡片', () => {
    const attachment = {
      id: '22222222-2222-4222-8222-222222222222',
      sessionId: '11111111-1111-4111-8111-111111111111',
      name: 'project-screen.png',
      storageName: '22222222-2222-4222-8222-222222222222.png',
      mediaType: 'image/png' as const,
      sha256: 'a'.repeat(64),
      byteLength: 68,
      width: 1,
      height: 1,
    }
    const state = createConversationState([
      core({
        type: 'tool-start',
        toolUseId: 'view-image-1',
        toolName: 'ViewImage',
        input: { path: 'project-screen.png' },
      }),
      core({ type: 'image-viewed', toolUseId: 'view-image-1', attachments: [attachment] }),
      core({
        type: 'tool-end',
        toolUseId: 'view-image-1',
        result: '图片已读取',
        isError: false,
      }),
    ])

    const block = state.blocks[0]
    assert.equal(block?.kind, 'tool')
    assert.deepEqual(block?.kind === 'tool' ? block.call.attachments : [], [attachment])
  })

  it('按 canonical BTW 终态开放续接，停止不会自动结束侧链', () => {
    let state = createConversationState()
    state = applyCoreEvent(state, {
      type: 'btw-message-accepted',
      inputId: 'btw-input-1',
      text: '顺便问一下',
      btw: {
        conversationId: '11111111-1111-4111-8111-111111111111',
        turnIndex: 1,
        mode: 'btw',
      },
    })
    const sideBlock = state.blocks.at(-1)
    assert.equal(sideBlock?.kind === 'user' ? sideBlock.btw?.mode : null, 'btw')
    state = applyCoreEvent(state, { type: 'text-delta', text: '侧对话回答' })
    state = applyCoreEvent(state, { type: 'step-committed' })
    state = applyCoreEvent(state, {
      type: 'work-finished',
      durationMs: 100,
      outcome: 'completed',
      forkTurnId: null,
      btw: {
        conversationId: '11111111-1111-4111-8111-111111111111',
        turnIndex: 1,
        continuationAvailable: true,
      },
    })
    assert.deepEqual(state.btwContinuation, {
      conversationId: '11111111-1111-4111-8111-111111111111',
      turnIndex: 1,
    })

    state = applyCoreEvent(state, {
      type: 'user-message-accepted',
      inputId: 'main-input-1',
      text: '回到主对话',
      startsTurn: true,
    })
    assert.equal(state.btwContinuation, null)

    state = applyCoreEvent(state, {
      type: 'btw-message-accepted',
      inputId: 'btw-input-3',
      text: '第三轮',
      btw: {
        conversationId: '22222222-2222-4222-8222-222222222222',
        turnIndex: 3,
        mode: 'bbtw',
      },
    })
    state = applyCoreEvent(state, { type: 'text-delta', text: '第三轮回答' })
    state = applyCoreEvent(state, { type: 'step-committed' })
    state = applyCoreEvent(state, {
      type: 'work-finished',
      durationMs: 100,
      outcome: 'completed',
      forkTurnId: null,
      btw: {
        conversationId: '22222222-2222-4222-8222-222222222222',
        turnIndex: 3,
        continuationAvailable: false,
      },
    })
    assert.equal(state.btwContinuation, null)

    state = applyCoreEvent(state, {
      type: 'btw-message-accepted',
      inputId: 'btw-input-stopped',
      text: '被停止',
      btw: {
        conversationId: '33333333-3333-4333-8333-333333333333',
        turnIndex: 1,
        mode: 'btw',
      },
    })
    state = applyCoreEvent(state, { type: 'text-delta', text: '部分回答' })
    state = applyCoreEvent(state, {
      type: 'work-finished',
      durationMs: 50,
      outcome: 'stopped',
      forkTurnId: null,
      btw: {
        conversationId: '33333333-3333-4333-8333-333333333333',
        turnIndex: 1,
        continuationAvailable: true,
      },
    })
    assert.deepEqual(state.btwContinuation, {
      conversationId: '33333333-3333-4333-8333-333333333333',
      turnIndex: 1,
    })
  })

  it('BTW 编辑原位替换最新侧轮次并移除旧回复', () => {
    let state = createConversationState()
    state = applyCoreEvent(state, {
      type: 'btw-message-accepted',
      inputId: 'btw-original',
      text: '第二轮原文',
      btw: {
        conversationId: '44444444-4444-4444-8444-444444444444',
        turnIndex: 2,
        mode: 'bbtw',
      },
    })
    state = applyCoreEvent(state, { type: 'text-delta', text: '旧回复片段' })
    state = applyCoreEvent(state, {
      type: 'work-finished',
      durationMs: 20,
      outcome: 'stopped',
      forkTurnId: null,
      btw: {
        conversationId: '44444444-4444-4444-8444-444444444444',
        turnIndex: 2,
        continuationAvailable: true,
      },
    })

    state = applyCoreEvent(state, {
      type: 'btw-message-edited',
      previousInputId: 'btw-original',
      inputId: 'btw-edited',
      text: '第二轮改写',
      btw: {
        conversationId: '44444444-4444-4444-8444-444444444444',
        turnIndex: 2,
        mode: 'bbtw',
      },
    })

    assert.deepEqual(state.blocks.map((block) =>
      block.kind === 'user' ? [block.kind, block.inputId, block.text] : [block.kind]), [
      ['user', 'btw-edited', '第二轮改写'],
    ])
    assert.equal(state.pendingBtw?.turnIndex, 2)
    assert.equal(state.btwContinuation, null)
    assert.equal(editableUserBlockId(state.blocks), state.blocks[0]?.id)
  })

  it('重放 BTW 编辑事实时不会留下重复的新输入块', () => {
    const conversationId = '55555555-5555-4555-8555-555555555555'
    let state = createConversationState()
    state = applyCoreEvent(state, {
      type: 'btw-message-accepted',
      inputId: 'btw-original',
      text: '原文',
      btw: { conversationId, turnIndex: 1, mode: 'btw' },
    })
    state = applyCoreEvent(state, { type: 'text-delta', text: '旧回复' })
    state = applyCoreEvent(state, {
      type: 'work-finished',
      durationMs: 20,
      outcome: 'stopped',
      forkTurnId: null,
      btw: { conversationId, turnIndex: 1, continuationAvailable: true },
    })
    state = applyCoreEvent(state, {
      type: 'btw-message-accepted',
      inputId: 'btw-edited',
      text: '改写',
      btw: { conversationId, turnIndex: 1, mode: 'btw' },
    })
    state = applyCoreEvent(state, {
      type: 'btw-message-edited',
      previousInputId: 'btw-original',
      inputId: 'btw-edited',
      text: '改写',
      btw: { conversationId, turnIndex: 1, mode: 'btw' },
    })

    assert.deepEqual(state.blocks.map((block) =>
      block.kind === 'user' ? [block.kind, block.inputId, block.text] : [block.kind]), [
      ['user', 'btw-edited', '改写'],
    ])
  })
})

function core(event: Extract<ViewEvent, { type: 'core-event' }>['event']): ViewEvent {
  return { type: 'core-event', event }
}

function checkpointEvents(toolUseId: string, path: string): ViewEvent[] {
  return [
    core({ type: 'tool-start', toolUseId, toolName: 'WriteFile', input: { path } }),
    core({ type: 'tool-end', toolUseId, result: 'ok', isError: false }),
    core({
      type: 'checkpoint-created',
      toolUseId,
      hash: `checkpoint-${toolUseId}`,
      coverage: 'complete',
    }),
  ]
}

function taskPlan(revision: number) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    goal: '完成长任务',
    status: 'active' as const,
    revision,
    items: [
      {
        id: 'T1',
        kind: 'work' as const,
        outcome: '核心能力已经实现',
        status: revision > 1 ? 'completed' as const : 'in_progress' as const,
        evidence: revision > 1 ? ['完成'] : [],
      },
      {
        id: 'T2',
        kind: 'work' as const,
        outcome: '相关调用已经统一',
        status: revision > 1 ? 'in_progress' as const : 'pending' as const,
        evidence: [],
      },
      {
        id: 'T3',
        kind: 'verification' as const,
        outcome: '整体结果通过验证',
        status: 'pending' as const,
        evidence: [],
      },
    ],
  }
}
