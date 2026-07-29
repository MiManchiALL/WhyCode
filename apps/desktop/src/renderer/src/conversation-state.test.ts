import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ViewEvent } from '@whycode/core'
import {
  applyCoreEvent,
  createConversationState,
  editableUserBlockId,
  eventsAfterRuntimeSnapshot,
  resumeTargetCommitted,
  toggleExpanded,
} from './conversation-state.ts'

describe('会话界面时间线重建', () => {
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
    assert.doesNotMatch(JSON.stringify(state.blocks), /out:default_api/)
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
    assert.equal(state.pendingStep, null)
  })

  it('Renderer 初始化只接续快照边界之后的实时事件', () => {
    const events = eventsAfterRuntimeSnapshot([
      { sequence: 10, event: { type: 'text-delta', text: '已包含在快照中' } },
      { sequence: 11, event: { type: 'text-delta', text: '快照之后的新内容' } },
    ], 10)

    assert.deepEqual(events, [{ type: 'text-delta', text: '快照之后的新内容' }])
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
      core({ type: 'work-finished', durationMs: 61_000 }),
    ])

    assert.deepEqual(state.blocks, [{
      kind: 'work-duration',
      id: 'b0',
      durationMs: 61_000,
    }])
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

  it('实时编辑把已中止根消息留在原位置，并让新 turn 复用该锚点', () => {
    let state = createConversationState([
      { type: 'user-message', inputId: 'old-input', text: '旧问题', startsTurn: true },
      core({ type: 'turn-start', turnId: 'turn-old' }),
      core({ type: 'work-finished', durationMs: 1_500 }),
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

  it('只有已正常收尾且没有可见输出的最后根消息才展示编辑入口', () => {
    let state = applyCoreEvent(
      applyCoreEvent(
        createConversationState(),
        { type: 'user-message-accepted', inputId: 'input-1', text: '旧消息', startsTurn: true },
      ),
      { type: 'turn-start', turnId: 'turn-1' },
    )

    assert.equal(editableUserBlockId(state.blocks), null)
    state = applyCoreEvent(state, { type: 'work-finished', durationMs: 1000 })
    assert.equal(editableUserBlockId(state.blocks), state.blocks[0]?.id)
    state = applyCoreEvent(state, { type: 'text-delta', text: '已有输出' })
    assert.equal(editableUserBlockId(state.blocks), null)
  })

  it('重放中的编辑输入副本与实时编辑事件走同一 reducer 且不重复显示', () => {
    const state = createConversationState([
      { type: 'user-message', inputId: 'old-input', text: '旧问题', startsTurn: true },
      core({ type: 'turn-start', turnId: 'turn-old' }),
      core({ type: 'work-finished', durationMs: 800 }),
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

  it('重启重放时忽略旧命令快照，并在恢复后清除精确检查点按钮', () => {
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

  it('恢复计划替换历史块，同时只把新计划置于顶部活动状态', () => {
    const previousActive = taskPlan(1)
    const next = { ...taskPlan(1), id: '22222222-2222-4222-8222-222222222222', goal: '开发 CSGO' }
    const state = createConversationState([core({
      type: 'task-plan-replaced',
      previous: {
        ...previousActive,
        status: 'superseded',
        summary: '用户明确切换游戏',
        replacedByPlanId: next.id,
      },
      plan: next,
    })])

    assert.deepEqual(state.taskPlan, next)
    const archived = state.blocks.find((block) => block.kind === 'plan-replaced')
    assert.equal(archived?.kind === 'plan-replaced' && archived.previous.status, 'superseded')
    assert.equal(archived?.kind === 'plan-replaced' && archived.nextGoal, '开发 CSGO')
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
        text: '分析截图',
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
})

function core(event: Extract<ViewEvent, { type: 'core-event' }>['event']): ViewEvent {
  return { type: 'core-event', event }
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
        title: '实现',
        acceptance: '代码完成',
        status: revision > 1 ? 'completed' as const : 'in_progress' as const,
        evidence: revision > 1 ? ['完成'] : [],
      },
      {
        id: 'T2',
        kind: 'verification' as const,
        title: '验证',
        acceptance: '测试通过',
        status: revision > 1 ? 'in_progress' as const : 'pending' as const,
        evidence: [],
      },
    ],
  }
}
