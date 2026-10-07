import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { AgentSession, ConsensusCoordinator, SessionStore, localWorkspace } from '@whycode/core'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { deferred, finalStream, languageModel, modelEntry } from './subagent-test-fixture.ts'

for (const source of ['user', 'shutdown'] as const) {
  for (const consensus of [false, true]) {
    it(`停止来源贯穿宿主、模型和持久化：${source} consensus=${consensus}`, { timeout: 10_000 }, async t => {
      const root = await mkdtemp(join(tmpdir(), 'whycode-session-stop-'))
      const store = new SessionStore(join(root, 'sessions'))
      const workspace = localWorkspace(root)
      const journal = await store.create({ workspace, modelId: 'test:subagent' })
      const started = deferred<AbortSignal>()
      const model = modelEntry(languageModel(async ({ abortSignal }) => {
        assert.ok(abortSignal)
        return {
          stream: new ReadableStream({
            start(controller) {
              abortSignal.addEventListener('abort', () => controller.error(new Error('已中止')), { once: true })
              started.resolve(abortSignal)
            },
          }),
        }
      }))
      const runtime = new DesktopSessionRuntime({ workspace, modelId: model.id, emit: () => {} })
      const options = {
        model,
        providerConfig: { apiKey: 'test' },
        promptContext: { projectDir: root, osPlatform: process.platform },
        sessionRecorder: journal,
        emit: () => {},
        requestApproval: async () => ({ approved: false }),
      }
      const session = new AgentSession(options)
      runtime.session = session
      runtime.journal = journal
      if (consensus) {
        runtime.coordinator = new ConsensusCoordinator({
          mainSession: session,
          projectDir: root,
          sessionScratchDir: join(root, 'scratch'),
          agents: { B: options, C: options },
          osPlatform: process.platform,
          emit: () => {},
          requestApproval: options.requestApproval,
          onTaskStart: (...args) => journal.recordConsensusTaskStart(...args),
          onTaskEnd: (...args) => journal.recordConsensusTaskEnd(...args),
        })
      }
      let resumed: AgentSession | undefined
      const running = (runtime.coordinator ?? session).handleUserMessage('检查当前项目')
      t.after(async () => {
        await runtime.abort('shutdown')
        await running
        await resumed?.dispose()
        await runtime.dispose()
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      })

      const signal = await started.promise
      await runtime.abort(source)
      await running
      const reason = source === 'user' ? 'user-cancel' : 'process-interruption'
      assert.equal(signal.reason, reason)
      const snapshot = session.captureMessageSnapshot()
      const marker = snapshot.find(message => typeof message.content === 'string'
        && message.content.includes('<whycode-turn-aborted version='))
      assert.ok(marker && typeof marker.content === 'string')
      assert.ok(marker.content.includes(`reason="${reason}"`))
      if (source === 'shutdown') assert.doesNotMatch(marker.content, /用户主动停止/)
      const reopened = await new SessionStore(join(root, 'sessions')).open(journal.sessionId)
      assert.deepEqual(reopened.initialMessages, snapshot)
      let nextPrompt: unknown
      resumed = new AgentSession({
        ...options,
        sessionRecorder: reopened,
        model: modelEntry(languageModel(async ({ prompt }) => {
          nextPrompt = prompt
          return finalStream('处理新的问题。')
        })),
      })
      assert.equal(await resumed.handleUserMessage('先回答另一个问题'), 'completed')
      assert.ok(JSON.stringify(nextPrompt).includes(`reason=\\"${reason}\\"`))
    })
  }
}
