import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ViewEvent } from '@whycode/core'
import { ViewTimeline, type ViewEventWriter } from './view-timeline.ts'

class Writer implements ViewEventWriter {
  batches: ViewEvent[][] = []

  get initialViewEvents(): readonly ViewEvent[] {
    return this.batches.flat()
  }

  get initialViewEventTimestamps(): readonly string[] {
    return this.initialViewEvents.map(() => 'persisted-at')
  }

  async recordViewEvents(events: ViewEvent[]): Promise<void> {
    this.batches.push(structuredClone(events))
  }
}

describe('ViewTimeline', () => {
  it('快照等待期间新增的稳定写入也进入同一无缺口边界', async () => {
    const committed: ViewEvent[] = []
    const releases: (() => void)[] = []
    const writer = {
      get initialViewEvents() {
        return committed
      },
      async recordViewEvents(events: ViewEvent[]) {
        await new Promise<void>((resolve) => releases.push(resolve))
        committed.push(...structuredClone(events))
      },
    }
    const timeline = new ViewTimeline(() => assert.fail('不应写入失败'))
    timeline.capture(writer, { type: 'turn-start', turnId: 'turn-1' })
    const snapshot = timeline.snapshot(writer)
    timeline.capture(writer, { type: 'turn-start', turnId: 'turn-2' })

    releases.shift()?.()
    await Promise.resolve()
    let settled = false
    void snapshot.then(() => { settled = true })
    await Promise.resolve()
    assert.equal(settled, false)

    releases.shift()?.()
    assert.deepEqual(await snapshot, [
      { type: 'core-event', event: { type: 'turn-start', turnId: 'turn-1' } },
      { type: 'core-event', event: { type: 'turn-start', turnId: 'turn-2' } },
    ])
  })

  it('切回运行中会话时同时返回已写稳事实与未提交瞬时时间线', async () => {
    const writer = new Writer()
    const timeline = new ViewTimeline(() => assert.fail('不应写入失败'))
    timeline.capture(writer, { type: 'turn-start', turnId: 'turn-1' })
    timeline.capture(writer, { type: 'thinking-delta', text: '分析中' })
    timeline.capture(writer, {
      type: 'peer-event',
      agentId: 'B',
      event: { type: 'text-delta', text: 'B 正在评审' },
    })

    const snapshot = await timeline.snapshot(writer)

    assert.deepEqual(snapshot, [
      { type: 'core-event', event: { type: 'turn-start', turnId: 'turn-1' } },
      { type: 'core-event', event: { type: 'thinking-delta', text: '分析中' } },
      {
        type: 'core-event',
        event: {
          type: 'peer-event',
          agentId: 'B',
          event: { type: 'text-delta', text: 'B 正在评审' },
        },
      },
    ])
  })

  it('在时间线副本完成后读取事件游标，形成同一快照边界', async () => {
    const writer = new Writer()
    const timeline = new ViewTimeline(() => assert.fail('不应写入失败'))
    timeline.capture(writer, { type: 'turn-start', turnId: 'turn-1' })

    const snapshot = await timeline.snapshotAt(writer, () => 42)

    assert.equal(snapshot.boundary, 42)
    assert.deepEqual(snapshot.events, [
      { type: 'core-event', event: { type: 'turn-start', turnId: 'turn-1' } },
    ])
    assert.deepEqual(snapshot.eventTimestamps, ['persisted-at'])
  })

  it('运行中快照保持事件时间同序，合并流式文本采用最新片段时间', async () => {
    const writer = new Writer()
    const timeline = new ViewTimeline(() => assert.fail('不应写入失败'))
    timeline.capture(writer, { type: 'turn-start', turnId: 'turn-1' }, '2026-08-08T10:00:00.000Z')
    timeline.capture(writer, { type: 'text-delta', text: '你' }, '2026-08-08T10:00:01.000Z')
    timeline.capture(writer, { type: 'text-delta', text: '好' }, '2026-08-08T10:00:02.000Z')

    const snapshot = await timeline.snapshotAt(writer, () => 7)

    assert.deepEqual(snapshot.events, [
      { type: 'core-event', event: { type: 'turn-start', turnId: 'turn-1' } },
      { type: 'core-event', event: { type: 'text-delta', text: '你好' } },
    ])
    assert.deepEqual(snapshot.eventTimestamps, [
      'persisted-at',
      '2026-08-08T10:00:02.000Z',
    ])
  })

  it('只在 step 提交后写入并合并流式文本', async () => {
    const writer = new Writer()
    const timeline = new ViewTimeline(() => assert.fail('不应写入失败'))
    timeline.capture(writer, { type: 'text-delta', text: '你好' })
    timeline.capture(writer, { type: 'text-delta', text: '世界' })
    timeline.capture(writer, { type: 'step-committed' })
    await Promise.resolve()

    assert.equal(writer.batches.length, 1)
    assert.deepEqual(writer.batches[0], [
      { type: 'core-event', event: { type: 'text-delta', text: '你好世界' } },
    ])
  })

  it('turn 起点立即写入，不随被丢弃的首个 step 消失', async () => {
    const writer = new Writer()
    const timeline = new ViewTimeline(() => assert.fail('不应写入失败'))
    timeline.capture(writer, { type: 'turn-start', turnId: 'turn-1' })
    timeline.capture(writer, { type: 'thinking-delta', text: '未完成推理' })
    timeline.capture(writer, { type: 'step-discarded' })
    await Promise.resolve()

    assert.deepEqual(writer.batches, [[
      { type: 'core-event', event: { type: 'turn-start', turnId: 'turn-1' } },
    ]])
  })

  it('用户停止时只写稳已经展示的正文，仍丢弃推理和工具状态', async () => {
    const writer = new Writer()
    const timeline = new ViewTimeline(() => assert.fail('不应写入失败'))
    timeline.capture(writer, { type: 'thinking-delta', text: '未完成推理' })
    timeline.capture(writer, {
      type: 'tool-start',
      toolUseId: 'tool-1',
      toolName: 'RunCommand',
      input: { command: 'slow' },
    })
    timeline.capture(writer, { type: 'text-delta', text: '已经输出的正文' })
    timeline.capture(writer, { type: 'step-output-retained' })
    timeline.capture(writer, { type: 'step-discarded' })
    await timeline.flush()

    assert.deepEqual(writer.batches, [[
      { type: 'core-event', event: { type: 'text-delta', text: '已经输出的正文' } },
    ]])
  })

  it('丢弃未提交 step，B/C 并发缓冲互不干扰', async () => {
    const writer = new Writer()
    const timeline = new ViewTimeline(() => assert.fail('不应写入失败'))
    timeline.capture(writer, {
      type: 'peer-event',
      agentId: 'B',
      event: { type: 'text-delta', text: 'B 的分析' },
    })
    timeline.capture(writer, {
      type: 'peer-event',
      agentId: 'C',
      event: { type: 'text-delta', text: 'C 的半截分析' },
    })
    timeline.capture(writer, {
      type: 'peer-event',
      agentId: 'C',
      event: { type: 'step-discarded' },
    })
    timeline.capture(writer, {
      type: 'peer-event',
      agentId: 'B',
      event: { type: 'step-committed' },
    })
    await Promise.resolve()

    assert.equal(writer.batches.length, 1)
    assert.equal(writer.batches[0]?.[0]?.type, 'core-event')
    assert.match(JSON.stringify(writer.batches[0]), /B 的分析/)
    assert.doesNotMatch(JSON.stringify(writer.batches), /C 的半截分析/)
  })

  it('协商节点立即写入，检查点随所属 step 提交', async () => {
    const writer = new Writer()
    const timeline = new ViewTimeline(() => assert.fail('不应写入失败'))
    timeline.capture(writer, {
      type: 'checkpoint-created',
      toolUseId: 'tool-1',
      hash: 'abc',
      coverage: 'complete',
    })
    timeline.capture(writer, { type: 'step-committed' })
    timeline.capture(writer, {
      type: 'candidate-submitted',
      agentId: 'Main',
      candidateId: 'M1',
      summary: '实质结论',
    })
    await Promise.resolve()

    assert.equal(writer.batches.length, 2)
    assert.match(JSON.stringify(writer.batches), /实质结论/)
    assert.match(JSON.stringify(writer.batches), /checkpoint-created/)
  })

  it('图片协商降级作为稳定控制事件立即写入', async () => {
    const writer = new Writer()
    const timeline = new ViewTimeline(() => assert.fail('不应写入失败'))

    timeline.capture(writer, { type: 'consensus-skipped', reason: 'image-input' })
    await Promise.resolve()

    assert.deepEqual(writer.batches, [[{
      type: 'core-event',
      event: { type: 'consensus-skipped', reason: 'image-input' },
    }]])
  })

  it('ViewImage 图片只随成功提交的 step 进入可恢复时间线', async () => {
    const writer = new Writer()
    const timeline = new ViewTimeline(() => assert.fail('不应写入失败'))
    const attachment = {
      id: '22222222-2222-4222-8222-222222222222',
      sessionId: '11111111-1111-4111-8111-111111111111',
      name: 'screen.png',
      storageName: '22222222-2222-4222-8222-222222222222.png',
      mediaType: 'image/png' as const,
      sha256: 'a'.repeat(64),
      byteLength: 68,
      width: 1,
      height: 1,
    }

    timeline.capture(writer, {
      type: 'image-viewed', toolUseId: 'discarded', attachments: [attachment],
    })
    timeline.capture(writer, { type: 'step-discarded' })
    timeline.capture(writer, {
      type: 'image-viewed', toolUseId: 'committed', attachments: [attachment],
    })
    timeline.capture(writer, { type: 'step-committed' })
    await Promise.resolve()

    assert.equal(writer.batches.length, 1)
    assert.match(JSON.stringify(writer.batches), /image-viewed/)
    assert.match(JSON.stringify(writer.batches), /committed/)
    assert.doesNotMatch(JSON.stringify(writer.batches), /discarded/)
  })

  it('任务计划只在所属 step 稳定提交后写入历史', async () => {
    const writer = new Writer()
    const timeline = new ViewTimeline(() => assert.fail('不应写入失败'))
    const event = { type: 'task-plan-updated' as const, plan: taskPlan() }

    timeline.capture(writer, event)
    timeline.capture(writer, { type: 'step-discarded' })
    timeline.capture(writer, event)
    timeline.capture(writer, { type: 'step-committed' })
    await Promise.resolve()

    assert.equal(writer.batches.length, 1)
    assert.match(JSON.stringify(writer.batches), /完成长任务/)
  })

  it('计划替换的旧快照与新活动计划在同一稳定 step 写入', async () => {
    const writer = new Writer()
    const timeline = new ViewTimeline(() => assert.fail('不应写入失败'))
    const next = taskPlan()
    const event = {
      type: 'task-plan-replaced' as const,
      previous: {
        ...taskPlan(),
        status: 'superseded' as const,
        summary: '用户切换到新任务',
        replacedByPlanId: next.id,
      },
      plan: next,
    }

    timeline.capture(writer, event)
    timeline.capture(writer, { type: 'step-discarded' })
    timeline.capture(writer, event)
    timeline.capture(writer, { type: 'step-committed' })
    await Promise.resolve()

    assert.equal(writer.batches.length, 1)
    assert.match(JSON.stringify(writer.batches), /task-plan-replaced/)
    assert.match(JSON.stringify(writer.batches), /用户切换到新任务/)
  })

  it('待回答问题只在所属 step 提交后写入历史', async () => {
    const writer = new Writer()
    const timeline = new ViewTimeline(() => assert.fail('不应写入失败'))
    const event = {
      type: 'user-question' as const,
      question: {
        id: 'question-1',
        questions: [{
          header: '实现偏好',
          question: '你更看重哪一点？',
          options: [
            { label: '简单可靠', description: '减少复杂度' },
            { label: '功能完整', description: '覆盖更多场景' },
          ],
        }],
      },
    }

    timeline.capture(writer, event)
    timeline.capture(writer, { type: 'step-discarded' })
    timeline.capture(writer, event)
    timeline.capture(writer, { type: 'step-committed' })
    await Promise.resolve()

    assert.equal(writer.batches.length, 1)
    assert.match(JSON.stringify(writer.batches), /你更看重哪一点/)
  })
})

function taskPlan() {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    goal: '完成长任务',
    status: 'active' as const,
    revision: 1,
    items: [
      {
        id: 'T1',
        kind: 'work' as const,
        title: '实现',
        acceptance: '代码完成',
        status: 'in_progress' as const,
        evidence: [],
      },
      {
        id: 'T2',
        kind: 'verification' as const,
        title: '验证',
        acceptance: '测试通过',
        status: 'pending' as const,
        evidence: [],
      },
    ],
  }
}
