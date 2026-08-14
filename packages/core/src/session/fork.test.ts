import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import { importImageAttachments } from '../attachments/storage.ts'
import { CheckpointManager } from '../checkpoints/manager.ts'
import { createMcpToolStateMessage, findMcpToolState } from '../mcp/state.ts'
import { localWorkspace, type ManagedWorkspaceBinding } from '../workspace/types.ts'
import { getSessionPaths } from './metadata.ts'
import { SessionStore, type SessionJournal } from './store.ts'

const tempRoots: string[] = []
const storeRoots = new WeakMap<SessionStore, string>()
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('SessionStore Fork', () => {
  it('从完整模型回复复制独立事实源并按同族稳定编号', async () => {
    const store = await createStore()
    const source = await store.create({
      workspace: localWorkspace('C:\\work\\fork'),
      modelId: 'test:model',
    })
    await source.recordUserInput('分析这个问题', true)
    await source.recordTurnStart('turn-1', [message('user', '分析这个问题')])
    await source.recordStep('turn-1', [message('assistant', '第一版回答')])
    await source.recordTurnEnd('turn-1', 'completed')
    await recordForkBoundary(source, 'turn-1')
    await source.recordUserInput('继续原会话', true)
    await source.recordTurnStart('turn-2', [message('user', '继续原会话')])
    await source.recordStep('turn-2', [message('assistant', '第二版回答')])
    await source.recordTurnEnd('turn-2', 'completed')

    const firstFork = await store.fork(
      source,
      'turn-1',
      source.metadataSnapshot.workspace,
    )
    const secondFork = await store.fork(
      firstFork,
      'turn-1',
      firstFork.metadataSnapshot.workspace,
    )
    assert.notEqual(firstFork.sessionId, source.sessionId)
    assert.deepEqual(firstFork.initialMessages, [
      message('user', '分析这个问题'),
      message('assistant', '第一版回答'),
    ])
    assert.equal(firstFork.metadataSnapshot.title, '分析这个问题（2）')
    assert.equal(secondFork.metadataSnapshot.title, '分析这个问题（3）')
    assert.equal(firstFork.metadataSnapshot.forkOrigin?.sourceSessionId, source.sessionId)
    assert.equal(secondFork.metadataSnapshot.forkOrigin?.sourceSessionId, firstFork.sessionId)
    assert.equal(secondFork.metadataSnapshot.forkOrigin?.familyId, source.sessionId)

    await firstFork.recordUserInput('分支继续追问', true)
    await firstFork.recordTurnStart('fork-turn', [message('user', '分支继续追问')])
    await firstFork.recordStep('fork-turn', [message('assistant', '分支独立回答')])
    await firstFork.recordTurnEnd('fork-turn', 'completed')
    assert.deepEqual(source.initialMessages, [
      message('user', '分析这个问题'),
      message('assistant', '第一版回答'),
      message('user', '继续原会话'),
      message('assistant', '第二版回答'),
    ])

    await source.recordUserInput('只改变源会话', true)
    assert.equal(firstFork.initialMessages.length, 4)
    assert.equal(await store.delete(source.sessionId), true)
    assert.deepEqual((await store.open(firstFork.sessionId)).initialMessages, [
      message('user', '分析这个问题'),
      message('assistant', '第一版回答'),
      message('user', '分支继续追问'),
      message('assistant', '分支独立回答'),
    ])
  })

  it('拒绝从任何未完整结束的回复创建分支', async () => {
    const store = await createStore()
    const source = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await source.recordUserInput('执行任务', true)
    await source.recordTurnStart('turn-aborted', [message('user', '执行任务')])
    await source.recordStep('turn-aborted', [message('assistant', '未完成')])
    await source.recordTurnEnd('turn-aborted', 'aborted')

    await assert.rejects(
      store.fork(source, 'turn-aborted', source.metadataSnapshot.workspace),
      /只能从完整结束/,
    )

    await source.recordUserInput('等待回答', true)
    await source.recordTurnStart('turn-waiting', [message('user', '等待回答')])
    await source.recordStep('turn-waiting', [message('assistant', '请选择')])
    await source.recordTurnEnd('turn-waiting', 'waiting-user')
    await assert.rejects(
      store.fork(source, 'turn-waiting', source.metadataSnapshot.workspace),
      /只能从完整结束/,
    )
    assert.equal((await store.list()).length, 1)
  })

  it('分支不继承未送达模型的恢复草稿', async () => {
    const store = await createStore()
    const source = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const draftId = randomUUID()
    await source.recordUserInputWithId(draftId, '只属于源会话的恢复草稿', false)
    await source.recoverInterruptedWork()
    assert.deepEqual(source.pendingUserInputs.map(({ id, state }) => ({ id, state })), [{
      id: draftId,
      state: 'restored',
    }])

    const rootInputId = randomUUID()
    await source.recordUserInputWithId(rootInputId, '完成一次新对话', true)
    await source.recordTurnStart(
      'turn-after-draft',
      [message('user', '完成一次新对话')],
      undefined,
      [],
      undefined,
      rootInputId,
    )
    await source.recordStep('turn-after-draft', [message('assistant', '完整回答')])
    await source.recordTurnEnd('turn-after-draft', 'completed')
    await recordForkBoundary(source, 'turn-after-draft')

    const forked = await store.fork(
      source,
      'turn-after-draft',
      source.metadataSnapshot.workspace,
    )
    assert.deepEqual(forked.pendingUserInputs, [])
    assert.deepEqual(forked.initialMessages, [
      message('user', '完成一次新对话'),
      message('assistant', '完整回答'),
    ])
    assert.deepEqual(source.pendingUserInputs.map(({ id, state }) => ({ id, state })), [{
      id: draftId,
      state: 'restored',
    }])
  })

  it('分支保留已消费恢复草稿的原子身份但不恢复草稿状态', async () => {
    const store = await createStore()
    const source = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const draftId = randomUUID()
    await source.recordUserInputWithId(draftId, '崩溃前草稿', false)
    await source.recoverInterruptedWork()

    const rootInputId = randomUUID()
    await source.recordUserInputWithId(
      rootInputId,
      '重新提交后的问题',
      true,
      [],
      [draftId],
    )
    await source.recordTurnStart(
      'turn-consuming-draft',
      [message('user', '重新提交后的问题')],
      undefined,
      [],
      undefined,
      rootInputId,
    )
    await source.recordStep('turn-consuming-draft', [message('assistant', '重新提交后的回答')])
    await source.recordTurnEnd('turn-consuming-draft', 'completed')
    await recordForkBoundary(source, 'turn-consuming-draft')

    const forked = await store.fork(
      source,
      'turn-consuming-draft',
      source.metadataSnapshot.workspace,
    )
    assert.deepEqual(forked.pendingUserInputs, [])
    assert.deepEqual(forked.initialMessages, [
      message('user', '重新提交后的问题'),
      message('assistant', '重新提交后的回答'),
    ])
  })

  it('完整 turn 仍须具有持久化的完整工作边界', async () => {
    const store = await createStore()
    const source = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await source.recordUserInput('给出最终回答', true)
    await source.recordTurnStart('turn-without-boundary', [message('user', '给出最终回答')])
    await source.recordStep('turn-without-boundary', [message('assistant', '回答正文')])
    await source.recordTurnEnd('turn-without-boundary', 'completed')

    await assert.rejects(
      store.fork(source, 'turn-without-boundary', source.metadataSnapshot.workspace),
      /Fork 边界/,
    )
    assert.equal((await store.list()).length, 1)
  })

  it('同批事件中只复制完整工作边界及其之前的事件', async () => {
    const store = await createStore()
    const source = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await source.recordUserInput('给出可以 Fork 的回答', true)
    await source.recordTurnStart('turn-batched-boundary', [
      message('user', '给出可以 Fork 的回答'),
    ])
    await source.recordStep('turn-batched-boundary', [message('assistant', '最终回答')])
    await source.recordTurnEnd('turn-batched-boundary', 'completed')
    await source.recordViewEvents([
      {
        type: 'core-event',
        event: {
          type: 'work-finished',
          durationMs: 10,
          outcome: 'completed',
          forkTurnId: 'turn-batched-boundary',
        },
      },
      {
        type: 'core-event',
        event: { type: 'error', message: '边界之后的事件', recoverable: true },
      },
    ])

    const forked = await store.fork(
      source,
      'turn-batched-boundary',
      source.metadataSnapshot.workspace,
    )
    assert.equal(source.initialViewEvents.length, 3)
    assert.deepEqual(forked.initialViewEvents, source.initialViewEvents.slice(0, -1))
  })

  it('没有最终文本的工具型回合不是 Fork 锚点', async () => {
    const store = await createStore()
    const source = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await source.recordUserInput('执行工具', true)
    await source.recordTurnStart('turn-tool-only', [message('user', '执行工具')])
    await source.recordTurnEnd('turn-tool-only', 'completed')
    await recordForkBoundary(source, 'turn-tool-only')

    await assert.rejects(
      store.fork(source, 'turn-tool-only', source.metadataSnapshot.workspace),
      /最终文本/,
    )
    assert.equal((await store.list()).length, 1)
  })

  it('早期进度文本不能替代最后模型步骤的最终文本', async () => {
    const store = await createStore()
    const source = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await source.recordUserInput('先说明进度再执行工具', true)
    await source.recordTurnStart('turn-progress-then-tool', [
      message('user', '先说明进度再执行工具'),
    ])
    await source.recordStep('turn-progress-then-tool', [message('assistant', '先汇报阶段进度。')])
    await source.recordStep('turn-progress-then-tool', [
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          toolCallId: 'read-final-step',
          toolName: 'ReadFile',
          input: { path: 'README.md' },
        }],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: 'read-final-step',
          toolName: 'ReadFile',
          output: { type: 'text', value: '文件内容' },
        }],
      },
    ])
    await source.recordTurnEnd('turn-progress-then-tool', 'completed')
    await recordForkBoundary(source, 'turn-progress-then-tool')

    await assert.rejects(
      store.fork(source, 'turn-progress-then-tool', source.metadataSnapshot.workspace),
      /最终文本/,
    )
    assert.equal((await store.list()).length, 1)
  })

  it('同一步文本加工具调用仍属于执行过程而不是最终回复', async () => {
    const store = await createStore()
    const source = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    await source.recordUserInput('执行后结束', true)
    await source.recordTurnStart('turn-text-with-tool', [message('user', '执行后结束')])
    await source.recordStep('turn-text-with-tool', [{
      role: 'assistant',
      content: [
        { type: 'text', text: '我现在执行最后一步。' },
        {
          type: 'tool-call',
          toolCallId: 'finish-tool',
          toolName: 'CloseTaskPlan',
          input: { outcome: 'completed' },
        },
      ],
    }])
    await source.recordTurnEnd('turn-text-with-tool', 'completed')
    await recordForkBoundary(source, 'turn-text-with-tool')

    await assert.rejects(
      store.fork(source, 'turn-text-with-tool', source.metadataSnapshot.workspace),
      /最终文本/,
    )
    assert.equal((await store.list()).length, 1)
  })

  it('分支复制附件字节并把附件归属改为新会话', async () => {
    const store = await createStore()
    const root = storeRoots.get(store)!
    const source = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const imagePath = join(root, 'source.png')
    await writeFile(imagePath, ONE_PIXEL_PNG)
    const attachments = await importImageAttachments(
      [{ kind: 'path', path: imagePath }],
      source.attachmentDirectory,
      source.sessionId,
    )
    await source.recordUserInput('分析图片', true, attachments)
    await source.recordTurnStart('turn-image', [message('user', '分析图片')])
    await source.recordStep('turn-image', [message('assistant', '图片结论')])
    await source.recordTurnEnd('turn-image', 'completed')
    await recordForkBoundary(source, 'turn-image')

    const forked = await store.fork(
      source,
      'turn-image',
      source.metadataSnapshot.workspace,
    )
    const [forkedAttachment] = forked.initialImageAttachments
    assert.ok(forkedAttachment)
    assert.equal(forkedAttachment.sessionId, forked.sessionId)
    assert.equal(forkedAttachment.storageName, attachments[0]!.storageName)
    assert.deepEqual(
      await readFile(join(forked.attachmentDirectory, forkedAttachment.storageName)),
      ONE_PIXEL_PNG,
    )

    await store.delete(source.sessionId)
    const reopened = await store.open(forked.sessionId)
    assert.equal(reopened.initialImageAttachments[0]?.sessionId, forked.sessionId)
  })

  it('分支独立复制所选回复范围内的文件检查点', async () => {
    const store = await createStore()
    const root = storeRoots.get(store)!
    const source = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const trackedFile = join(root, 'tracked.txt')
    await writeFile(trackedFile, 'before')
    await source.recordUserInput('修改文件', true)
    await source.recordTurnStart('turn-checkpoint', [message('user', '修改文件')])

    const sourceManager = new CheckpointManager({
      sessionDir: getSessionPaths(root, source.sessionId).checkpoints,
      sessionId: source.sessionId,
    })
    const prepared = await sourceManager.prepare('tool-write', 'turn-checkpoint', {
      kind: 'exact-files',
      paths: [trackedFile],
    })
    assert.ok(prepared)
    await writeFile(trackedFile, 'after')
    assert.ok(await sourceManager.finalize(prepared))
    await source.recordStep('turn-checkpoint', [message('assistant', '文件已修改')])
    await source.recordTurnEnd('turn-checkpoint', 'completed')
    await recordForkBoundary(source, 'turn-checkpoint')

    const forked = await store.fork(
      source,
      'turn-checkpoint',
      source.metadataSnapshot.workspace,
    )
    const forkedManager = new CheckpointManager({
      sessionDir: getSessionPaths(root, forked.sessionId).checkpoints,
      sessionId: forked.sessionId,
    })
    assert.ok(await forkedManager.getReady('tool-write'))

    await store.delete(source.sessionId)
    const restored = await forkedManager.restore('tool-write', 'files')
    assert.equal(restored.ok, true, restored.error)
    assert.equal(await readFile(trackedFile, 'utf8'), 'before')
  })

  it('受管工作区分支把文件检查点重定向到独立快照', async () => {
    const store = await createStore()
    const root = storeRoots.get(store)!
    const sourceDirectory = join(root, 'managed-source')
    const targetDirectory = join(root, 'managed-fork')
    await mkdir(sourceDirectory)
    await mkdir(targetDirectory)
    const createdAt = new Date().toISOString()
    const sourceWorkspace: ManagedWorkspaceBinding = {
      mode: 'managed',
      id: randomUUID(),
      workingDirectory: sourceDirectory,
      createdAt,
    }
    const targetWorkspace: ManagedWorkspaceBinding = {
      mode: 'managed',
      id: randomUUID(),
      workingDirectory: targetDirectory,
      createdAt,
    }
    const source = await store.create({ workspace: sourceWorkspace, modelId: 'test:model' })
    const sourceFile = join(sourceDirectory, 'tracked.txt')
    const targetFile = join(targetDirectory, 'tracked.txt')
    await writeFile(sourceFile, 'before')
    await source.recordUserInput('修改受管文件', true)
    await source.recordTurnStart('turn-managed-checkpoint', [
      message('user', '修改受管文件'),
    ])

    const sourceManager = new CheckpointManager({
      sessionDir: getSessionPaths(root, source.sessionId).checkpoints,
      sessionId: source.sessionId,
    })
    const prepared = await sourceManager.prepare(
      'tool-managed-write',
      'turn-managed-checkpoint',
      { kind: 'exact-files', paths: [sourceFile] },
    )
    assert.ok(prepared)
    await writeFile(sourceFile, 'after')
    assert.ok(await sourceManager.finalize(prepared))
    await source.recordStep('turn-managed-checkpoint', [
      message('assistant', '受管文件已修改'),
    ])
    await source.recordTurnEnd('turn-managed-checkpoint', 'completed')
    await recordForkBoundary(source, 'turn-managed-checkpoint')
    await writeFile(targetFile, 'after')

    await assert.rejects(
      store.fork(source, 'turn-managed-checkpoint', sourceWorkspace),
      /必须使用独立受管工作区快照/,
    )

    const forked = await store.fork(
      source,
      'turn-managed-checkpoint',
      targetWorkspace,
    )
    assert.deepEqual(forked.metadataSnapshot.workspace, targetWorkspace)
    await writeFile(sourceFile, 'source-changed-after-fork')
    const forkedManager = new CheckpointManager({
      sessionDir: getSessionPaths(root, forked.sessionId).checkpoints,
      sessionId: forked.sessionId,
    })

    const restored = await forkedManager.restore('tool-managed-write', 'files')
    assert.equal(restored.ok, true, restored.error)
    assert.equal(await readFile(targetFile, 'utf8'), 'before')
    assert.equal(await readFile(sourceFile, 'utf8'), 'source-changed-after-fork')
  })

  it('分支从所有可恢复消息副本中清除临时 MCP 项目信任', async () => {
    const store = await createStore()
    const source = await store.create({ workspace: localWorkspace(null), modelId: 'test:model' })
    const trustedState = createMcpToolStateMessage({
      tools: [],
      trustedProjectConfigurationFingerprint: 'a'.repeat(64),
      serverInstructions: [],
    })
    const sourceMessages = [message('user', '检查项目配置'), trustedState]
    await source.recordUserInput('检查项目配置', true)
    await source.recordTurnStart('turn-before-snapshot', sourceMessages)
    await source.recordSnapshot('rollback', sourceMessages, 'turn-before-snapshot')
    await source.recordStep('turn-before-snapshot', [message('assistant', '检查完成')])
    await source.recordTurnEnd('turn-before-snapshot', 'completed')
    await source.recordUserInput('继续处理', true)
    await source.recordTurnStart('turn-trust', [message('user', '继续处理')])
    await source.recordStep('turn-trust', [message('assistant', '继续完成')])
    await source.recordTurnEnd('turn-trust', 'completed')
    await recordForkBoundary(source, 'turn-trust')

    const forked = await store.fork(
      source,
      'turn-trust',
      source.metadataSnapshot.workspace,
    )
    assert.equal(
      findMcpToolState(forked.initialMessages).trustedProjectConfigurationFingerprint,
      null,
    )
    assert.equal(
      findMcpToolState(forked.messagesBeforeTurn('turn-before-snapshot') ?? [])
        .trustedProjectConfigurationFingerprint,
      null,
    )
  })
})

async function createStore(): Promise<SessionStore> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-fork-'))
  tempRoots.push(root)
  const store = new SessionStore(root)
  storeRoots.set(store, root)
  return store
}

async function recordForkBoundary(journal: SessionJournal, turnId: string): Promise<void> {
  await journal.recordViewEvents([{
    type: 'core-event',
    event: {
      type: 'work-finished',
      durationMs: 10,
      outcome: 'completed',
      forkTurnId: turnId,
    },
  }])
}

function message(role: 'user' | 'assistant', content: string): ModelMessage {
  return { role, content }
}
