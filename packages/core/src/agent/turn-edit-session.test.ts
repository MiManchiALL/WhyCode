import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { CheckpointManager } from '../checkpoints/manager.ts'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import { localWorkspace } from '../workspace/types.ts'
import { AgentSession } from './session.ts'
import { inspectLatestTurnEdit } from './turn-edit.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(files: boolean, command: boolean, internalTurns = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'whycode-edit-files-'))
  roots.push(root)
  const path = join(root, 'a.txt')
  await writeFile(path, 'before')
  const store = new SessionStore(join(root, 'sessions'))
  const recorder = await store.create({ workspace: localWorkspace(root), modelId: 'test:edit' })
  const manager = new CheckpointManager({ sessionId: recorder.sessionId, sessionDir: recorder.checkpointDirectory })
  const inputId = randomUUID()
  await recorder.recordUserInputWithId(inputId, '原始问题', true)
  const turnIds = internalTurns ? ['first', 'internal'] : ['first']
  for (const [index, turnId] of turnIds.entries()) {
    await recorder.recordTurnStart(turnId, index === 0 ? [{ role: 'user', content: '原始问题' }] : [],
      undefined, [], undefined, index === 0 ? inputId : undefined)
    await recorder.recordViewEvents([{ type: 'core-event', event: { type: 'turn-start', turnId } }])
    if (files) {
      const checkpoint = await manager.prepare(`write-${turnId}`, turnId, { kind: 'exact-files', paths: [path] })
      assert.ok(checkpoint)
      await writeFile(path, turnId)
      await manager.finalize(checkpoint)
    }
    if (command) await manager.recordBarrier(`command-${turnId}`, turnId, '命令副作用未跟踪')
    await recorder.recordStep(turnId, [{ role: 'assistant', content: `原始回答 ${turnId}` }])
    await recorder.recordTurnEnd(turnId, 'completed')
  }
  const model = new MockLanguageModelV4({ doStream: async () => ({
    stream: simulateReadableStream({ chunks: [
      { type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: '新回答' },
      { type: 'text-end', id: 'answer' },
      { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      } },
    ] }),
  }) })
  const entry: ModelEntry = {
    id: 'test:edit', displayName: 'Edit test', provider: 'openai', protocol: 'openai-responses',
    capabilities: { supportsNativeTools: true, supportsImageInput: false, reasoningExposure: 'none',
      structuredOutput: 'tool-based', promptCaching: 'none', contextWindow: 100_000, maxOutput: 4_000 },
    create: () => model,
  }
  const events: CoreEvent[] = []
  const scheduled: string[] = []
  const session = new AgentSession({
    model: entry, providerConfig: { apiKey: 'test' }, sessionRecorder: recorder,
    promptContext: { projectDir: root, osPlatform: process.platform },
    requestApproval: async () => ({ approved: true }), emit: event => events.push(event),
    scheduleProjectMutation: async (mutation, _signal, operation) => {
      scheduled.push(mutation.type)
      return operation()
    },
  })
  return { root, path, store, recorder, manager, model, session, events, scheduled }
}

for (const files of [false, true]) for (const command of [false, true]) {
  it(`编辑检查只读返回四种状态：文件=${files}，未跟踪操作=${command}`, async () => {
    const f = await fixture(files, command)
    const before = [...f.recorder.initialMessages]
    assert.deepEqual(await f.session.inspectLatestTurnEdit('first'), {
      hasFileChanges: files, hasUntrackedEffects: command,
    })
    const cold = await f.store.open(f.recorder.sessionId)
    assert.deepEqual(await inspectLatestTurnEdit(cold, 'first'), {
      hasFileChanges: files, hasUntrackedEffects: command,
    })
    assert.equal(await readFile(f.path, 'utf8'), files ? 'first' : 'before')
    assert.deepEqual(f.recorder.initialMessages, before)
    assert.deepEqual(f.scheduled, [])
    assert.equal(f.model.doStreamCalls.length, 0)
  })
}

it('默认编辑仅替换对话，即使运行过命令也可以重新发送', async () => {
  const f = await fixture(true, true)
  const prepared = await f.session.prepareLatestTurnEdit('first', '新问题')
  assert.equal(await readFile(f.path, 'utf8'), 'first')
  assert.equal(await prepared.startMain(), 'completed')
  const prompt = JSON.stringify(f.model.doStreamCalls[0]?.prompt)
  assert.match(prompt, /新问题/)
  assert.doesNotMatch(prompt, /原始问题|原始回答/)
})

it('勾选恢复覆盖用户整轮内部 turn，工具的命令屏障仍禁止文件与对话一起回滚', async () => {
  const f = await fixture(true, true, true)
  assert.equal((await f.manager.checkRestore('write-first', 'files-and-chat')).ok, false)
  const prepared = await f.session.prepareLatestTurnEdit('first', '新问题', true)
  assert.equal(await readFile(f.path, 'utf8'), 'before')
  assert.equal(await f.manager.getReady('write-first'), null)
  assert.equal(await f.manager.getReady('write-internal'), null)
  assert.deepEqual(f.scheduled, ['turn-edit'])
  assert.equal(f.model.doStreamCalls.length, 0)
  assert.equal(await prepared.startMain(), 'completed')
  const reopened = await f.store.open(f.recorder.sessionId)
  assert.doesNotMatch(JSON.stringify(reopened.initialMessages), /原始问题|原始回答/)
})

it('恢复冲突保留原对话、外部改动和检查点，不启动模型；取消勾选后可以提交', async () => {
  const f = await fixture(true, false)
  const before = [...f.recorder.initialMessages]
  await writeFile(f.path, '外部改动')
  await assert.rejects(f.session.prepareLatestTurnEdit('first', '新问题', true), /已拒绝覆盖/)
  assert.equal(await readFile(f.path, 'utf8'), '外部改动')
  assert.deepEqual(f.recorder.initialMessages, before)
  assert.ok(await f.manager.getReady('write-first'))
  assert.equal(f.model.doStreamCalls.length, 0)
  assert.equal(f.session.isBusy, false)
  await f.session.prepareLatestTurnEdit('first', '新问题', false)
  assert.equal(await readFile(f.path, 'utf8'), '外部改动')
})

it('日志 flush 失败恢复原日志尾部和文件，可安全重试同一条编辑', async t => {
  const f = await fixture(true, false)
  const transcript = join(f.root, 'sessions', f.recorder.sessionId, 'transcript.jsonl')
  const before = await readFile(transcript, 'utf8')
  const handle = await open(transcript, 'r')
  const prototype = Object.getPrototypeOf(handle)
  await handle.close()
  const originalSync = prototype.sync
  let failed = false
  t.mock.method(prototype, 'sync', async function (this: { sync: () => Promise<void> }) {
    if (!failed) { failed = true; throw new Error('模拟日志 flush 失败') }
    return originalSync.call(this)
  })
  await assert.rejects(f.session.prepareLatestTurnEdit('first', '新问题', true), /模拟日志 flush 失败/)
  t.mock.restoreAll()
  assert.equal(await readFile(transcript, 'utf8'), before)
  assert.equal(await readFile(f.path, 'utf8'), 'first')
  assert.ok(await f.manager.getReady('write-first'))
  assert.match(JSON.stringify((await f.store.open(f.recorder.sessionId)).initialMessages), /原始回答/)
  assert.equal(f.model.doStreamCalls.length, 0)
  await f.session.prepareLatestTurnEdit('first', '新问题', true)
  assert.equal(await readFile(f.path, 'utf8'), 'before')
})

it('只能编辑最新用户轮次，不从过期编辑入口恢复文件', async () => {
  const f = await fixture(true, false)
  await f.recorder.recordUserInput('更新的输入', true)
  await assert.rejects(f.session.prepareLatestTurnEdit('first', '过期编辑', true), /待处理输入|尚未处理|最新/)
  assert.equal(await readFile(f.path, 'utf8'), 'first')
})
