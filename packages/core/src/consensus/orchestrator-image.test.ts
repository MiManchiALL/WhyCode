import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import type { AgentSession } from '../agent/session.ts'
import type { QueuedMessage } from '../agent/user-input.ts'
import type { ImageAttachment } from '../attachments/types.ts'
import type { PdfAttachment } from '../pdf/types.ts'
import type { CoreEvent } from '../events.ts'
import type { ActivatedSkill } from '../skills/types.ts'
import { ConsensusCoordinator } from './orchestrator.ts'

interface MainCall {
  text: string
  urgent: boolean
  attachments: readonly ImageAttachment[]
  pdfAttachments?: readonly PdfAttachment[]
  skills?: readonly ActivatedSkill[]
  inputId?: string
}

describe('共识模式附件路由', () => {
  it('协调器空闲时图片跳过 B/C；Main 忙时立即补图直接进入自身 steering', async () => {
    const harness = createHarness()
    const running = harness.coordinator.handleUserMessage('先看图片', false, [harness.attachment], 'input-1')
    assert.equal(harness.calls.length, 1)
    assert.equal(harness.events.some((event) =>
      event.type === 'consensus-skipped' && event.reason === 'image-input'), true)

    harness.state.busy = true
    harness.state.running = true
    harness.coordinator.handleUserMessage('继续补图', true, [harness.attachment], 'input-2')
    assert.deepEqual(harness.calls[1], {
      text: '继续补图',
      urgent: true,
      attachments: [harness.attachment],
      inputId: 'input-2',
    })
    await running
  })

  it('B/C 评审时普通图片保留在队列，用户停止可完整取回', async () => {
    const harness = createHarness()
    const internals = harness.coordinator as unknown as {
      running: boolean
      peerPhase: boolean
    }
    internals.running = true
    internals.peerPhase = true

    harness.coordinator.handleUserMessage('按这张图调整', false, [harness.attachment], 'input-peer')
    assert.equal(harness.calls.length, 0)
    await harness.coordinator.abort()
    assert.deepEqual(harness.events.find(event => event.type === 'queue-restored')?.items, [{
      id: 'input-peer',
      text: '按这张图调整',
      attachments: [harness.attachment],
    }])
  })

  it('连续排队的 PDF 逐条交给 Main，并用独立原因声明未让 B/C 读取', async () => {
    const harness = createHarness()
    const running = harness.coordinator.handleUserMessage(
      '总结 PDF', false, [], 'input-pdf', [harness.pdfAttachment],
    )
    assert.deepEqual(harness.calls[0], {
      text: '总结 PDF',
      urgent: false,
      attachments: [],
      inputId: 'input-pdf',
      pdfAttachments: [harness.pdfAttachment],
    })
    assert.equal(harness.events.some((event) =>
      event.type === 'consensus-skipped' && event.reason === 'pdf-input'), true)

    harness.coordinator.handleUserMessage(
      '第二份 PDF', false, [], 'input-pdf-two', [harness.pdfAttachment],
    )
    harness.coordinator.handleUserMessage(
      '第三份 PDF', false, [], 'input-pdf-three', [harness.pdfAttachment], [harness.skill],
    )
    assert.equal(harness.calls.length, 1)
    await running
    assert.deepEqual(harness.calls.map(call => call.inputId), ['input-pdf', 'input-pdf-two', 'input-pdf-three'])
    assert.deepEqual(harness.calls[2]?.skills, [harness.skill])
    assert.equal(harness.events.filter(event => event.type === 'consensus-skipped').length, 3)
  })

  it('B/C 评审时 urgent 图片中止半截共识，留到回滚后由 Main 处理', () => {
    const harness = createHarness()
    const internals = harness.coordinator as unknown as {
      running: boolean
      peerPhase: boolean
      abortReason: string | null
      deferredTaskMessages: unknown[]
    }
    internals.running = true
    internals.peerPhase = true

    harness.coordinator.handleUserMessage('立即以此为准', true, [harness.attachment], 'input-now')
    assert.equal(internals.abortReason, 'user-cancel')
    assert.equal(internals.deferredTaskMessages.length, 1)
    assert.equal(harness.aborts.value, 1)
    const queued = harness.events.find((event) => event.type === 'message-queued')
    assert.deepEqual(queued?.type === 'message-queued' ? queued.attachments : undefined, [harness.attachment])
  })

  it('队列恢复写盘失败时不向界面伪报图片已回到草稿', async () => {
    const harness = createHarness({
      onInputsRestored: async () => { throw new Error('disk full') },
    })
    const running = harness.coordinator.handleUserMessage('当前图片', false, [harness.attachment])
    harness.coordinator.handleUserMessage('保留这张图', false, [harness.attachment], 'input-persisted')
    await harness.coordinator.abort()
    await running

    assert.equal(harness.events.some((event) => event.type === 'queue-restored'), false)
    assert.equal(harness.events.some((event) =>
      event.type === 'error' && event.message.includes('队列恢复')), true)
  })

  it('M1 讨论期间排队的 Skill 独立保管，重新编辑可取回原输入', async () => {
    const harness = createHarness()
    const internals = harness.coordinator as unknown as {
      running: boolean
      peerPhase: boolean
      executionPhase: boolean
    }
    internals.running = true
    internals.peerPhase = false
    internals.executionPhase = false
    harness.state.running = true

    harness.coordinator.handleUserMessage(
      '按 Skill 继续', false, [], 'input-skill', [], [harness.skill],
    )
    assert.deepEqual(harness.calls, [])
    const queued = harness.events.find((event) => event.type === 'message-queued')
    assert.deepEqual(
      queued?.type === 'message-queued' ? queued.skills?.map((skill) => skill.id) : [],
      [harness.skill.id],
    )

    assert.equal(await harness.coordinator.restoreQueuedMessage('input-skill'), true)
    const edited = harness.events.find(event => event.type === 'queued-message-edit-ready')
    assert.deepEqual(edited?.item.skills?.map(skill => skill.id), [harness.skill.id])
  })

  it('Main 已进入执行阶段时，Skill steering 直接进入当前根任务', () => {
    const harness = createHarness()
    const internals = harness.coordinator as unknown as {
      running: boolean
      peerPhase: boolean
      executionPhase: boolean
    }
    internals.running = true
    internals.peerPhase = false
    internals.executionPhase = true
    harness.state.running = true

    harness.coordinator.handleUserMessage(
      '立即补充流程', true, [], 'input-execution-skill', [], [harness.skill],
    )
    assert.deepEqual(harness.calls[0]?.skills, [harness.skill])
  })

  it('B/C 阶段的队列支持单条编辑、丢弃与马上发送', async () => {
    const restored: Array<{ ids: readonly string[]; replaced?: readonly string[] }> = []
    const discarded: string[][] = []
    const editHarness = createHarness({
      onInputsRestored: async (ids, replaced) => { restored.push({ ids, replaced }) },
    })
    const editInternals = editHarness.coordinator as unknown as { running: boolean; peerPhase: boolean }
    editInternals.running = true
    editInternals.peerPhase = true
    editHarness.coordinator.handleUserMessage('重新编辑', false, [], 'queue-edit')
    assert.equal(await editHarness.coordinator.restoreQueuedMessage('queue-edit', ['draft']), true)
    assert.deepEqual(restored, [{ ids: ['queue-edit'], replaced: ['draft'] }])
    assert.equal(editHarness.events.some((event) =>
      event.type === 'queued-message-edit-ready' && event.item.id === 'queue-edit'), true)

    const discardHarness = createHarness({
      onInputsDiscarded: async (ids) => { discarded.push([...ids]) },
    })
    const discardInternals = discardHarness.coordinator as unknown as { running: boolean; peerPhase: boolean }
    discardInternals.running = true
    discardInternals.peerPhase = true
    discardHarness.coordinator.handleUserMessage('直接丢弃', false, [], 'queue-discard')
    assert.equal(await discardHarness.coordinator.discardQueuedMessage('queue-discard'), true)
    assert.deepEqual(discarded, [['queue-discard']])
    assert.equal(discardHarness.events.some((event) =>
      event.type === 'message-dequeued' && event.id === 'queue-discard'), true)

    const nowHarness = createHarness()
    const nowInternals = nowHarness.coordinator as unknown as {
      running: boolean
      peerPhase: boolean
      deferredTaskMessages: Array<{ id: string }>
    }
    nowInternals.running = true
    nowInternals.peerPhase = true
    nowHarness.coordinator.handleUserMessage('马上发送', false, [], 'queue-now')
    assert.equal(nowHarness.coordinator.sendQueuedMessageNow('queue-now'), true)
    assert.equal(nowInternals.deferredTaskMessages[0]?.id, 'queue-now')
    assert.equal(nowHarness.aborts.value, 1)
  })
})

function createHarness(options: {
  onInputsRestored?: (inputIds: readonly string[], replaced?: readonly string[]) => Promise<void>
  onInputsDiscarded?: (inputIds: readonly string[]) => Promise<void>
} = {}) {
  const calls: MainCall[] = []
  const events: CoreEvent[] = []
  const state = { busy: false, running: false }
  const aborts = { value: 0 }
  const main = {
    setTerminalStatusManaged() {},
    isQueuedUserInput: () => false,
    get isBusy() { return state.busy },
    get isRunning() { return state.running },
    receiveUserInput(message: QueuedMessage, { urgent = false } = {}) {
      const { text, attachments, pdfAttachments, skills } = message
      calls.push({
        text,
        urgent,
        attachments: [...attachments],
        ...(message.persisted ? { inputId: message.id } : {}),
        ...(pdfAttachments.length ? { pdfAttachments: [...pdfAttachments] } : {}),
        ...(skills.length ? { skills: skills.map((skill) => structuredClone(skill)) } : {}),
      })
    },
    abort() { aborts.value++ },
  } as unknown as AgentSession
  const coordinator = new ConsensusCoordinator({
    mainSession: main,
    projectDir: process.cwd(),
    sessionScratchDir: '',
    agents: { B: {} as never, C: {} as never },
    osPlatform: 'win32',
    emit: (event) => events.push(event),
    requestApproval: async () => ({ approved: false }),
    onInputsRestored: options.onInputsRestored,
    onInputsDiscarded: options.onInputsDiscarded,
  })
  const id = randomUUID()
  const sessionId = randomUUID()
  const attachment: ImageAttachment = {
    id,
    sessionId,
    name: 'screen.png',
    storageName: `${id}.png`,
    mediaType: 'image/png',
    sha256: 'a'.repeat(64),
    byteLength: 100,
    width: 10,
    height: 10,
  }
  const pdfId = randomUUID()
  const pdfAttachment: PdfAttachment = {
    id: pdfId,
    sessionId,
    name: 'guide.pdf',
    storageName: `${pdfId}.pdf`,
    mediaType: 'application/pdf',
    sha256: 'b'.repeat(64),
    byteLength: 200,
    pageCount: 3,
  }
  const skill: ActivatedSkill = {
    id: `skill:${'c'.repeat(64)}`,
    path: 'C:\\project\\.agents\\skills\\verify\\SKILL.md',
    rootPath: 'C:\\project\\.agents\\skills\\verify',
    name: 'verify',
    description: '验证结果',
    scope: 'project',
    digest: `sha256:${'d'.repeat(64)}`,
    content: '---\nname: verify\ndescription: 验证结果\n---\nVERIFY',
  }
  return { coordinator, calls, events, state, aborts, attachment, pdfAttachment, skill }
}
