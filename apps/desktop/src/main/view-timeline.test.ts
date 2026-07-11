import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ViewEvent } from '@whycode/core'
import { ViewTimeline, type ViewEventWriter } from './view-timeline.ts'

class Writer implements ViewEventWriter {
  batches: ViewEvent[][] = []

  async recordViewEvents(events: ViewEvent[]): Promise<void> {
    this.batches.push(structuredClone(events))
  }
}

describe('ViewTimeline', () => {
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
    timeline.capture(writer, { type: 'thinking-delta', text: '未完成思考' })
    timeline.capture(writer, { type: 'step-discarded' })
    await Promise.resolve()

    assert.deepEqual(writer.batches, [[
      { type: 'core-event', event: { type: 'turn-start', turnId: 'turn-1' } },
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
        header: '实现偏好',
        question: '你更看重哪一点？',
        options: [
          { label: '简单可靠', description: '减少复杂度' },
          { label: '功能完整', description: '覆盖更多场景' },
        ],
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
