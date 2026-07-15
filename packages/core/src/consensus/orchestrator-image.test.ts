import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import type { AgentSession } from '../agent/session.ts'
import type { ImageAttachment } from '../attachments/types.ts'
import type { CoreEvent, QueuedUserMessage } from '../events.ts'
import { ConsensusCoordinator } from './orchestrator.ts'

interface MainCall {
  text: string
  urgent: boolean
  attachments: readonly ImageAttachment[]
  inputId?: string
}

describe('共识模式图片路由', () => {
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
      }>): Promise<void>
    }

    await internals.restoreQueuedMessages([{
      id: 'input-persisted',
      persistedInputId: 'input-persisted',
      text: '保留这张图',
      attachments: [harness.attachment],
    }])

    assert.equal(harness.events.some((event) => event.type === 'queue-restored'), false)
    assert.equal(harness.events.some((event) =>
      event.type === 'error' && event.message.includes('队列恢复')), true)
  })
})

function createHarness(options: {
  onInputsRestored?: (inputIds: readonly string[]) => Promise<void>
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
    ) {
      calls.push({ text, urgent, attachments: [...attachments], ...(inputId ? { inputId } : {}) })
    },
    abort() { aborts.value++ },
  } as unknown as AgentSession
  const coordinator = new ConsensusCoordinator({
    mainSession: main,
    projectDir: null,
    scratchRoot: '',
    conversationId: 'test-conversation',
    agents: { B: {} as never, C: {} as never },
    osPlatform: 'win32',
    emit: (event) => events.push(event),
    requestApproval: async () => ({ approved: false }),
    onInputsRestored: options.onInputsRestored,
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
  return { coordinator, calls, events, state, aborts, attachment }
}
