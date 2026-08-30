import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_VISIBLE_TOOL_OUTPUT_CHARS,
  isWellFormedUnicode,
} from '../index.ts'
import {
  TOOL_IMAGE_ATTACHMENT_MAX_COUNT,
  USER_IMAGE_ATTACHMENT_MAX_COUNT,
} from '../attachments/limits.ts'
import {
  compactViewEvent,
  pushCoalescedViewEvent,
  toViewEvent,
  viewEventSchema,
  type ViewEvent,
} from './view-events.ts'

describe('用户可见事件契约', () => {
  it('只接收可恢复内容，排除审批和运行状态，并保留持久化检查点', () => {
    assert.equal(toViewEvent({ type: 'agent-status', status: 'working' }), null)
    assert.equal(toViewEvent({ type: 'context-usage', usage: null }), null)
    assert.equal(
      toViewEvent({
        type: 'user-message-accepted',
        inputId: 'root-live',
        text: '仅用于当前窗口即时显示',
        startsTurn: true,
      }),
      null,
    )
    assert.equal(
      toViewEvent({
        type: 'user-message-edited',
        previousTurnId: 'turn-old',
        inputId: 'root-edited',
        text: '编辑后的消息',
        taskPlan: null,
      }),
      null,
    )
    assert.equal(
      toViewEvent({
        type: 'approval-request',
        requestId: 'approval-1',
        toolName: 'WriteFile',
        input: {},
        reason: '需要确认',
      }),
      null,
    )
    assert.deepEqual(
      toViewEvent({
        type: 'checkpoint-created',
        toolUseId: 'tool-1',
        hash: 'abc',
        coverage: 'complete',
      }),
      {
        type: 'core-event',
        event: {
          type: 'checkpoint-created',
          toolUseId: 'tool-1',
          hash: 'abc',
          coverage: 'complete',
        },
      },
    )
    assert.deepEqual(
      toViewEvent({ type: 'message-injected', id: 'queue-1', text: '补充要求' }),
      { type: 'user-message', inputId: 'queue-1', text: '补充要求', startsTurn: false },
    )
    assert.deepEqual(
      toViewEvent({ type: 'consensus-skipped', reason: 'image-input' }),
      { type: 'core-event', event: { type: 'consensus-skipped', reason: 'image-input' } },
    )
    assert.deepEqual(
      toViewEvent({
        type: 'message-injected',
        id: 'queue-2',
        text: '下一项任务',
        startsTurn: true,
      }),
      { type: 'user-message', inputId: 'queue-2', text: '下一项任务', startsTurn: true },
    )
  })

  it('合并连续文本但保持工具边界', () => {
    const events: ViewEvent[] = []
    pushCoalescedViewEvent(events, core({ type: 'text-delta', text: '前半' }))
    pushCoalescedViewEvent(events, core({ type: 'text-delta', text: '后半' }))
    pushCoalescedViewEvent(
      events,
      core({ type: 'tool-start', toolUseId: 'tool-1', toolName: 'ReadFile', input: {} }),
    )

    assert.equal(events.length, 2)
    assert.deepEqual(events[0], core({ type: 'text-delta', text: '前半后半' }))
  })

  it('工具进度的可见投影有界并保留 Unicode 安全的最新尾部', () => {
    const events: ViewEvent[] = []
    pushCoalescedViewEvent(events, core({
      type: 'tool-progress',
      toolUseId: 'tool-1',
      output: `早期${'a'.repeat(MAX_VISIBLE_TOOL_OUTPUT_CHARS)}\uD83D\uDE00`,
    }))
    pushCoalescedViewEvent(events, core({
      type: 'tool-progress',
      toolUseId: 'tool-1',
      output: '最新结果',
    }))

    const event = events[0]?.type === 'core-event' ? events[0].event : null
    assert.equal(event?.type, 'tool-progress')
    const output = event?.type === 'tool-progress' ? event.output : ''
    assert.ok(output.length <= MAX_VISIBLE_TOOL_OUTPUT_CHARS)
    assert.match(output, /^\[较早的工具输出已省略\]/u)
    assert.match(output, /😀最新结果$/u)
    assert.equal(isWellFormedUnicode(output), true)
  })

  it('单条工具终值压缩为有界的可读展示文本', () => {
    const event = compactViewEvent(core({
      type: 'tool-end',
      toolUseId: 'tool-1',
      result: { output: 'x'.repeat(MAX_VISIBLE_TOOL_OUTPUT_CHARS + 1), ok: true },
      isError: false,
    }))
    const result = event.type === 'core-event' && event.event.type === 'tool-end'
      ? event.event.result
      : null

    assert.equal(typeof result, 'string')
    assert.ok((result as string).length <= MAX_VISIBLE_TOOL_OUTPUT_CHARS)
    assert.match(result as string, /^\[较早的工具输出已省略\]/u)
  })

  it('持久化工具实际落盘后的逐文件行统计并兼容旧事件', () => {
    const current = toViewEvent({
      type: 'tool-end',
      toolUseId: 'edit-1',
      result: '已编辑',
      isError: false,
      fileChanges: [{ path: 'src/app.ts', added: 3, removed: 1 }],
    })
    assert.deepEqual(current, {
      type: 'core-event',
      event: {
        type: 'tool-end',
        toolUseId: 'edit-1',
        result: '已编辑',
        isError: false,
        fileChanges: [{ path: 'src/app.ts', added: 3, removed: 1 }],
      },
    })
    assert.equal(viewEventSchema.safeParse({
      type: 'core-event',
      event: {
        type: 'tool-end',
        toolUseId: 'legacy-edit',
        result: 'ok',
        isError: false,
      },
    }).success, true)
  })

  it('拒绝结构不完整的持久化事件', () => {
    assert.equal(
      viewEventSchema.safeParse({ type: 'core-event', event: { type: 'tool-end' } }).success,
      false,
    )
    assert.equal(
      viewEventSchema.safeParse({
        type: 'core-event',
        event: {
          type: 'user-question',
          question: {
            id: 'old-question',
            header: '旧格式',
            question: '旧单题字段是否应继续读取？',
            options: [
              { label: '是', description: '继续读取旧结构' },
              { label: '否', description: '只接受当前结构' },
            ],
            questions: [{
              header: '旧格式',
              question: '旧单题字段是否应继续读取？',
              options: [
                { label: '是', description: '继续读取旧结构' },
                { label: '否', description: '只接受当前结构' },
              ],
            }],
          },
        },
      }).success,
      false,
    )
  })

  it('只持久化工作终值，不持久化运行中的墙钟起点', () => {
    assert.equal(toViewEvent({ type: 'work-started', startedAt: 100 }), null)
    assert.deepEqual(
      toViewEvent({
        type: 'work-finished',
        durationMs: 61_000,
        outcome: 'stopped',
        forkTurnId: null,
      }),
      {
        type: 'core-event',
        event: {
          type: 'work-finished',
          durationMs: 61_000,
          outcome: 'stopped',
          forkTurnId: null,
        },
      },
    )
  })

  it('图片元数据可持久化，但不允许把图片字节混入可见事件', () => {
    const event = {
      type: 'user-message',
      text: '分析图片',
      startsTurn: true,
      attachments: [{
        id: '22222222-2222-4222-8222-222222222222',
        sessionId: '11111111-1111-4111-8111-111111111111',
        name: 'screen.png',
        storageName: '22222222-2222-4222-8222-222222222222.png',
        mediaType: 'image/png' as const,
        byteLength: 68,
        width: 1,
        height: 1,
      }],
    }
    assert.equal(viewEventSchema.safeParse(event).success, true)
    assert.equal(viewEventSchema.safeParse({ ...event, text: '' }).success, true)
    assert.equal(viewEventSchema.safeParse({
      type: 'user-message',
      text: '',
      startsTurn: true,
    }).success, false)
    const parsed = viewEventSchema.parse({
      ...event,
      attachments: [{ ...event.attachments[0], base64: 'x' }],
    })
    assert.doesNotMatch(JSON.stringify(parsed), /base64/)
    assert.equal(viewEventSchema.safeParse({ ...event, startsTurn: false }).success, true)

    const viewed = viewEventSchema.parse({
      type: 'core-event',
      event: {
        type: 'image-viewed',
        toolUseId: 'view-image-1',
        attachments: [{ ...event.attachments[0], base64: 'forbidden' }],
      },
    })
    assert.match(JSON.stringify(viewed), /image-viewed/)
    assert.doesNotMatch(JSON.stringify(viewed), /base64|forbidden/)
    assert.deepEqual(
      toViewEvent({
        type: 'image-viewed',
        toolUseId: 'view-image-1',
        attachments: event.attachments,
      }),
      viewed,
    )
  })

  it('用户消息允许十图，普通图片工具仍保持四图边界', () => {
    const attachments = Array.from({
      length: USER_IMAGE_ATTACHMENT_MAX_COUNT + 1,
    }, (_, index) => {
      const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      return {
        id,
        sessionId: '11111111-1111-4111-8111-111111111111',
        name: `第 ${index + 1} 页.jpg`,
        storageName: `${id}.jpg`,
        mediaType: 'image/jpeg' as const,
        byteLength: 267,
        width: 4,
        height: 4,
      }
    })
    assert.equal(viewEventSchema.safeParse({
      type: 'core-event',
      event: {
        type: 'image-viewed',
        toolUseId: 'view-image-4',
        attachments: attachments.slice(0, TOOL_IMAGE_ATTACHMENT_MAX_COUNT),
      },
    }).success, true)
    assert.equal(viewEventSchema.safeParse({
      type: 'core-event',
      event: {
        type: 'image-viewed',
        toolUseId: 'view-image-5',
        attachments: attachments.slice(0, TOOL_IMAGE_ATTACHMENT_MAX_COUNT + 1),
      },
    }).success, false)
    assert.equal(viewEventSchema.safeParse({
      type: 'user-message',
      text: '十张用户图片可以作为同一条消息提交',
      startsTurn: true,
      attachments: attachments.slice(0, USER_IMAGE_ATTACHMENT_MAX_COUNT),
    }).success, true)
    assert.equal(viewEventSchema.safeParse({
      type: 'user-message',
      text: '第十一张超过用户上传边界',
      startsTurn: true,
      attachments,
    }).success, false)
  })

  it('PDF 可见事件只保存稳定元数据，不接受字节或路径字段', () => {
    const event = {
      type: 'user-message' as const,
      text: '分析 PDF',
      startsTurn: true,
      pdfAttachments: [{
        id: '22222222-2222-4222-8222-222222222222',
        sessionId: '11111111-1111-4111-8111-111111111111',
        name: 'guide.pdf',
        storageName: '22222222-2222-4222-8222-222222222222.pdf',
        mediaType: 'application/pdf' as const,
        sha256: 'a'.repeat(64),
        byteLength: 123,
        pageCount: 7,
      }],
    }
    assert.equal(viewEventSchema.safeParse(event).success, true)
    const parsed = viewEventSchema.parse({
      ...event,
      pdfAttachments: [{
        ...event.pdfAttachments[0],
        path: 'E:\\secret.pdf',
        base64: 'forbidden',
      }],
    })
    assert.doesNotMatch(JSON.stringify(parsed), /secret|base64|forbidden/)
  })
})

function core(event: Extract<ViewEvent, { type: 'core-event' }>['event']): ViewEvent {
  return { type: 'core-event', event }
}
