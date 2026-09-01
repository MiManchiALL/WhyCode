import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import type { AgentSession } from '../agent/session.ts'
import type { ImageAttachment } from '../attachments/types.ts'
import type { PdfAttachment } from '../pdf/types.ts'
import type { CoreEvent, QueuedUserMessage } from '../events.ts'
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
  it('协调器空闲时图片跳过 B/C；Main 忙时仍直接进入自身 steering', () => {
    const harness = createHarness()
    harness.coordinator.handleUserMessage('先看图片', false, [harness.attachment], 'input-1')
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
  })

  it('B/C 评审时普通图片只进入 Main 执行输入，并保留附件与身份', () => {
    const harness = createHarness()
    const internals = harness.coordinator as unknown as {
      running: boolean
      peerPhase: boolean
      takePendingInputs(text: string): { text: string; inputs: QueuedUserMessage[] }
    }
    internals.running = true
    internals.peerPhase = true

    harness.coordinator.handleUserMessage('按这张图调整', false, [harness.attachment], 'input-peer')
    assert.equal(harness.calls.length, 0)
    const execution = internals.takePendingInputs('execution package')
    assert.equal(execution.text, 'execution package')
    assert.deepEqual(execution.inputs, [{
      id: 'input-peer',
      text: '按这张图调整',
      attachments: [harness.attachment],
      imageDelivery: 'native',
    }])
  })

  it('PDF 始终只交给 Main，并用独立原因声明未让 B/C 读取', () => {
    const harness = createHarness()
    harness.coordinator.handleUserMessage(
      '总结 PDF', false, [], 'input-pdf', [harness.pdfAttachment],
    )
    assert.deepEqual(harness.calls, [{
      text: '总结 PDF',
      urgent: false,
      attachments: [],
      inputId: 'input-pdf',
      pdfAttachments: [harness.pdfAttachment],
    }])
    assert.equal(harness.events.some((event) =>
      event.type === 'consensus-skipped' && event.reason === 'pdf-input'), true)

    const internals = harness.coordinator as unknown as {
      running: boolean
      peerPhase: boolean
      takePendingInputs(text: string): { inputs: QueuedUserMessage[] }
    }
    internals.running = true
    internals.peerPhase = true
    harness.coordinator.handleUserMessage(
      '评审期间补充 PDF', false, [], 'input-pdf-peer', [harness.pdfAttachment],
    )
    assert.deepEqual(internals.takePendingInputs('execute').inputs, [{
      id: 'input-pdf-peer',
      text: '评审期间补充 PDF',
      pdfAttachments: [harness.pdfAttachment],
    }])
  })

  it('B/C 评审时 urgent 图片中止半截共识，留到回滚后由 Main 处理', () => {
    const harness = createHarness()
    const internals = harness.coordinator as unknown as {
      running: boolean
      peerPhase: boolean
      aborted: boolean
      deferredTaskMessages: unknown[]
    }
    internals.running = true
    internals.peerPhase = true

    harness.coordinator.handleUserMessage('立即以此为准', true, [harness.attachment], 'input-now')
    assert.equal(internals.aborted, true)
    assert.equal(internals.deferredTaskMessages.length, 1)
    assert.equal(harness.aborts.value, 1)
    const queued = harness.events.find((event) => event.type === 'message-queued')
    assert.deepEqual(queued?.type === 'message-queued' ? queued.attachments : undefined, [harness.attachment])
  })

  it('队列恢复写盘失败时不向界面伪报图片已回到草稿', async () => {
    const harness = createHarness({
      onInputsRestored: async () => { throw new Error('disk full') },
    })
    const internals = harness.coordinator as unknown as {
      restoreQueuedMessages(messages: Array<{
        id: string
        persistedInputId: string
        text: string
        attachments: ImageAttachment[]
        pdfAttachments: PdfAttachment[]
        skills: ActivatedSkill[]
      }>): Promise<void>
    }

    await internals.restoreQueuedMessages([{
      id: 'input-persisted',
      persistedInputId: 'input-persisted',
      text: '保留这张图',
      attachments: [harness.attachment],
      pdfAttachments: [],
      skills: [],
    }])

    assert.equal(harness.events.some((event) => event.type === 'queue-restored'), false)
    assert.equal(harness.events.some((event) =>
      event.type === 'error' && event.message.includes('队列恢复')), true)
  })

  it('M1 讨论期间保管 Skill，最终 Main 执行边界才交付完整快照', () => {
    const harness = createHarness()
    const internals = harness.coordinator as unknown as {
      running: boolean
      peerPhase: boolean
      executionPhase: boolean
      takePendingInputs(
        text: string,
        rootSkills?: readonly ActivatedSkill[],
      ): { inputs: QueuedUserMessage[]; skills: ActivatedSkill[] }
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

    const execution = internals.takePendingInputs('execution')
    assert.deepEqual(execution.skills, [harness.skill])
    assert.deepEqual(execution.inputs[0]?.skills?.map((skill) => skill.id), [harness.skill.id])
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
    const restored: string[][] = []
    const discarded: string[][] = []
    const editHarness = createHarness({
      onInputsRestored: async (ids) => { restored.push([...ids]) },
    })
    const editInternals = editHarness.coordinator as unknown as { running: boolean; peerPhase: boolean }
    editInternals.running = true
    editInternals.peerPhase = true
    editHarness.coordinator.handleUserMessage('重新编辑', false, [], 'queue-edit')
    assert.equal(await editHarness.coordinator.restoreQueuedMessage('queue-edit'), true)
    assert.deepEqual(restored, [['queue-edit']])
    assert.equal(editHarness.events.some((event) =>
      event.type === 'queue-restored' && event.items?.[0]?.id === 'queue-edit'), true)

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
  onInputsRestored?: (inputIds: readonly string[]) => Promise<void>
  onInputsDiscarded?: (inputIds: readonly string[]) => Promise<void>
} = {}) {
  const calls: MainCall[] = []
  const events: CoreEvent[] = []
  const state = { busy: false, running: false }
  const aborts = { value: 0 }
  const main = {
    get isBusy() { return state.busy },
    get isRunning() { return state.running },
    handleUserMessage(
      text: string,
      urgent: boolean,
      attachments: readonly ImageAttachment[],
      inputId?: string,
      pdfAttachments: readonly PdfAttachment[] = [],
      skills: readonly ActivatedSkill[] = [],
    ) {
      calls.push({
        text,
        urgent,
        attachments: [...attachments],
        ...(inputId ? { inputId } : {}),
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
