import assert from 'node:assert/strict'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import type { ConsensusPersistedState } from '../consensus/types.ts'
import { SessionCorruptError } from './chain.ts'
import { SessionStore } from './store.ts'

const tempRoots: string[] = []
const storeRoots = new WeakMap<SessionStore, string>()

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('SessionStore', () => {
  it('按稳定 turn 边界持久化并恢复消息', async () => {
    const store = await createStore()
    const journal = await store.create({ projectDir: 'C:\\work\\demo', modelId: 'test:model' })
    const user = message('user', '修复登录问题')
    const assistant = message('assistant', '已经完成')

    await journal.recordUserInput('修复登录问题')
    await journal.recordTurnStart('turn-1', [user])
    await journal.recordStep('turn-1', [assistant])
    await journal.recordTurnEnd('turn-1', 'completed')

    const reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.initialMessages, [user, assistant])
    assert.equal(reopened.interruptedTurnId, null)
    assert.equal(reopened.metadataSnapshot.title, '修复登录问题')
    assert.equal(reopened.metadataSnapshot.status, 'idle')
  })

  it('忽略崩溃留下的最后半行', async () => {
    const { store, journal, transcript } = await completedSession()
    await appendFile(transcript, '{"schemaVersion":1,"type":"messages"', 'utf8')

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.initialMessages.length, 2)
    assert.equal(reopened.metadataSnapshot.status, 'idle')
  })

  it('最后一行 JSON 完整但结构非法时拒绝恢复', async () => {
    const { store, journal, transcript } = await completedSession()
    await appendFile(transcript, '{"schemaVersion":1}\n', 'utf8')

    await assert.rejects(store.open(journal.sessionId), /结构无效/)
  })

  it('拒绝中间损坏而不是静默拼错父链', async () => {
    const { store, journal, transcript } = await completedSession()
    const text = await readFile(transcript, 'utf8')
    const lines = text.trimEnd().split('\n')
    lines.splice(2, 0, '{bad-json')
    await writeFile(transcript, `${lines.join('\n')}\n`, 'utf8')

    await assert.rejects(store.open(journal.sessionId), SessionCorruptError)
  })

  it('把没有 turn-end 的会话标记为中断且不生成工具重放', async () => {
    const store = await createStore()
    const journal = await store.create({ projectDir: null, modelId: 'test:model' })
    await journal.recordTurnStart('turn-crashed', [message('user', '继续执行')])

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.interruptedTurnId, 'turn-crashed')
    assert.equal(reopened.metadataSnapshot.status, 'interrupted')
    assert.deepEqual(reopened.initialMessages, [message('user', '继续执行')])
  })

  it('快照建立新根并丢弃旧活动链', async () => {
    const store = await createStore()
    const journal = await store.create({ projectDir: null, modelId: 'test:model' })
    await journal.recordTurnStart('turn-1', [message('user', '旧问题')])
    await journal.recordStep('turn-1', [message('assistant', '旧答案')])
    await journal.recordTurnEnd('turn-1', 'completed')

    const summary = message('user', '压缩摘要')
    await journal.recordSnapshot('compact', [summary])
    await journal.recordTurnStart('turn-2', [message('user', '新问题')])
    await journal.recordStep('turn-2', [message('assistant', '新答案')])
    await journal.recordTurnEnd('turn-2', 'completed')

    const reopened = await store.open(journal.sessionId)
    assert.deepEqual(reopened.initialMessages, [
      summary,
      message('user', '新问题'),
      message('assistant', '新答案'),
    ])
  })

  it('自动压缩快照保留正在运行的 turn 标记', async () => {
    const store = await createStore()
    const journal = await store.create({ projectDir: null, modelId: 'test:model' })
    const messages = [message('user', '需要压缩的请求')]
    await journal.recordTurnStart('turn-active', messages)
    await journal.recordSnapshot('compact', messages, 'turn-active')

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.interruptedTurnId, 'turn-active')
  })

  it('Main 回合已结束但共识未结束时仍标记为中断', async () => {
    const store = await createStore()
    const journal = await store.create({ projectDir: null, modelId: 'test:model' })
    const baseMessages = [message('user', '既有请求'), message('assistant', '既有回答')]
    await journal.recordTurnStart('base', [baseMessages[0]!])
    await journal.recordStep('base', [baseMessages[1]!])
    await journal.recordTurnEnd('base', 'completed')
    const state = consensusState(1)
    await journal.recordConsensusTaskStart('task-1', state)
    await journal.recordTurnStart('m1', [message('user', '讨论方案')])
    await journal.recordTurnEnd('m1', 'completed')

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.interruptedTurnId, null)
    assert.equal(reopened.interruptedConsensusTaskId, 'task-1')
    assert.equal(reopened.metadataSnapshot.status, 'interrupted')
    assert.deepEqual(reopened.initialConsensusState, state)
    assert.deepEqual(reopened.initialMessages, baseMessages)

    await reopened.recoverInterruptedWork()
    const recovered = await store.open(journal.sessionId)
    assert.equal(recovered.interruptedConsensusTaskId, null)
    assert.equal(recovered.metadataSnapshot.status, 'idle')
    assert.deepEqual(recovered.initialMessages, baseMessages)
  })

  it('共识任务终点原子提交稳定状态', async () => {
    const store = await createStore()
    const journal = await store.create({ projectDir: null, modelId: 'test:model' })
    await journal.recordConsensusTaskStart('task-1', consensusState(1))
    const committed = consensusState(1, '最终方案')
    await journal.recordConsensusTaskEnd('task-1', 'completed', committed)

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.interruptedConsensusTaskId, null)
    assert.equal(reopened.metadataSnapshot.status, 'idle')
    assert.deepEqual(reopened.initialConsensusState, committed)
  })

  it('快照保留活动共识边界和最后稳定状态', async () => {
    const store = await createStore()
    const journal = await store.create({ projectDir: null, modelId: 'test:model' })
    const state = consensusState(1)
    await journal.recordConsensusTaskStart('task-1', state)
    await journal.recordSnapshot('compact', [message('user', '压缩摘要')])

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.interruptedConsensusTaskId, 'task-1')
    assert.deepEqual(reopened.initialConsensusState, state)
    assert.deepEqual(reopened.initialMessages, [])
  })

  it('共识取消时回滚任务内模型消息', async () => {
    const store = await createStore()
    const journal = await store.create({ projectDir: null, modelId: 'test:model' })
    const baseMessages = [message('user', '稳定上下文'), message('assistant', '稳定回答')]
    await journal.recordTurnStart('base', [baseMessages[0]!])
    await journal.recordStep('base', [baseMessages[1]!])
    await journal.recordTurnEnd('base', 'completed')
    const state = consensusState(1)
    await journal.recordConsensusTaskStart('task-1', state)
    await journal.recordTurnStart('m1', [message('user', '内部协议提示')])
    await journal.recordStep('m1', [message('assistant', '半截候选')])
    await journal.recordTurnEnd('m1', 'completed')
    await journal.recordConsensusTaskEnd('task-1', 'aborted', state)

    const reopened = await store.open(journal.sessionId)
    assert.equal(reopened.metadataSnapshot.status, 'idle')
    assert.deepEqual(reopened.initialMessages, baseMessages)
  })

  it('metadata 损坏时从 transcript 重建会话列表', async () => {
    const { store, journal, metadata } = await completedSession()
    await journal.updateModel('test:other-model')
    await writeFile(metadata, '{broken', 'utf8')

    const sessions = await store.list()
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]!.sessionId, journal.sessionId)
    assert.equal(sessions[0]!.title, 'hello')
    assert.equal(sessions[0]!.modelId, 'test:other-model')
  })

  it('按项目过滤并安全删除会话', async () => {
    const store = await createStore()
    const first = await store.create({ projectDir: 'C:\\work\\one', modelId: 'test:model' })
    await store.create({ projectDir: 'C:\\work\\two', modelId: 'test:model' })

    assert.equal((await store.list('C:\\work\\one')).length, 1)
    assert.equal(await store.delete(first.sessionId), true)
    assert.equal(await store.delete(first.sessionId), false)
    assert.equal((await store.list()).length, 1)
    await assert.rejects(store.open('../escape'), /无效会话 ID/)
  })
})

async function createStore(): Promise<SessionStore> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-session-'))
  tempRoots.push(root)
  const store = new SessionStore(root)
  storeRoots.set(store, root)
  return store
}

async function completedSession() {
  const store = await createStore()
  const journal = await store.create({ projectDir: null, modelId: 'test:model' })
  await journal.recordUserInput('hello')
  await journal.recordTurnStart('turn-1', [message('user', 'hello')])
  await journal.recordStep('turn-1', [message('assistant', 'world')])
  await journal.recordTurnEnd('turn-1', 'completed')
  const dir = join(storeRoots.get(store)!, journal.sessionId)
  return {
    store,
    journal,
    transcript: join(dir, 'transcript.jsonl'),
    metadata: join(dir, 'metadata.json'),
  }
}

function message(role: 'user' | 'assistant', content: string): ModelMessage {
  return { role, content }
}

function consensusState(taskCounter: number, summary?: string): ConsensusPersistedState {
  return {
    taskCounter,
    sessionScore: { Main: summary ? 1 : 0, B: 0, C: 0 },
    memories: { B: [], C: [] },
    taskLog: summary ? [{ taskId: `task-${taskCounter}`, userText: '请求', m1Summary: summary }] : [],
  }
}
