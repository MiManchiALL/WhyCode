import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { AgentSession, SessionStore, localWorkspace, type SessionJournal, type WorkspaceBinding } from '@whycode/core'
import { cliProxyModelId, type WhycodeConfig } from './config.ts'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { listModelConnections, resolveModelConnection } from './model-connections.ts'
import { selectRuntimeModel, synchronizeRuntimeModelSelection } from './runtime-model-selection.ts'

const profileId = 'google:gemini-3.8-flash'
const selectedId = cliProxyModelId(profileId)
const alternativeId = 'deepseek:deepseek-flash'

function config(): WhycodeConfig {
  return {
    defaultModel: selectedId,
    providers: { deepseek: { apiKey: 'other-key' } },
    cliProxyApi: {
      apiKey: 'original-key', baseURL: 'http://localhost/v1', modelIds: [profileId],
      modelRoutes: { [profileId]: 'gemini-3.8-flash-high' },
    },
  }
}

function runtime(kind: 'draft' | 'registered' | 'restored' | 'live', modelId = selectedId) {
  const runtime = new DesktopSessionRuntime({
    workspace: localWorkspace(null), modelId, reasoningEffort: 'high', emit: () => {},
  })
  const selections: Parameters<AgentSession['setModelSelection']>[] = []
  if (kind === 'registered') runtime.registerSession()
  if (kind === 'restored' || kind === 'live') {
    runtime.journal = { sessionId: 'saved-session' } as SessionJournal
  }
  if (kind === 'live') runtime.session = {
    setModelSelection: async (...selection) => { selections.push(selection) },
  } as AgentSession
  return { runtime, selections }
}

describe('连接变动与会话模型选择', () => {
  it('目录暂缺与恢复均保留草稿、准备中、冷恢复和已加载会话的原模型', async () => {
    for (const kind of ['draft', 'registered', 'restored', 'live'] as const) {
      const f = runtime(kind)
      const missing = config()
      missing.cliProxyApi!.modelRoutes = {}
      await synchronizeRuntimeModelSelection(f.runtime, missing, alternativeId)
      assert.equal(f.runtime.modelId, selectedId)
      assert.equal(f.runtime.reasoningEffort, 'high')
      assert.equal(f.selections.length, 0)
      const item = listModelConnections(missing, f.runtime.modelId).find(model => model.id === selectedId)
      assert.equal(item?.displayName, 'Gemini 3.8 Flash（CLIProxyAPI）')
      assert.equal(item?.available, false)
      assert.equal(item?.retired, false)
      assert.match(item?.unavailableReason ?? '', /实例没有公布/)
      await synchronizeRuntimeModelSelection(f.runtime, config(), alternativeId)
      assert.equal(f.runtime.modelId, selectedId)
      assert.equal(resolveModelConnection(config(), f.runtime.modelId).ok, true)
      assert.deepEqual(f.selections.map(([entry]) => entry.id), kind === 'live' ? [selectedId] : [])
    }
  })

  it('明确停用、删除凭据或退役后仅草稿重新选型，已有会话等待用户选择', async () => {
    const variants = [config(), config(), config()]
    variants[0]!.cliProxyApi!.modelIds = []
    variants[1]!.cliProxyApi!.apiKey = ''
    delete variants[2]!.cliProxyApi
    for (const modelId of [selectedId, 'test:retired-model']) {
      for (const value of variants) {
        for (const kind of ['draft', 'registered', 'restored', 'live'] as const) {
          const f = runtime(kind, modelId)
          await synchronizeRuntimeModelSelection(f.runtime, value, alternativeId)
          assert.equal(f.runtime.modelId, kind === 'draft' ? alternativeId : modelId)
          assert.equal(f.runtime.reasoningEffort, kind === 'draft' ? 'default' : 'high')
          assert.equal(f.selections.length, 0)
          if (kind !== 'draft') assert.equal(resolveModelConnection(value, f.runtime.modelId!).ok, false)
        }
      }
    }
  })

  it('刷新同一连接的凭据与端点，不改写模型身份或启动回答', async () => {
    const f = runtime('live')
    const next = config()
    next.cliProxyApi!.apiKey = 'new-key'
    next.cliProxyApi!.baseURL = 'http://localhost:9000/v1'
    await synchronizeRuntimeModelSelection(f.runtime, next, alternativeId)
    assert.equal(f.runtime.modelId, selectedId)
    assert.equal(f.selections.length, 1)
    const [entry, connection, effort] = f.selections[0]!
    assert.equal(entry.id, selectedId)
    assert.deepEqual(connection, { apiKey: 'new-key', baseURL: 'http://localhost:9000/v1' })
    assert.equal(effort, 'high')
    assert.equal(f.runtime.workStartedAt, null)
  })
})

describe('显式切换模型', () => {
  for (const mode of ['local', 'ssh'] as const) {
    it(`${mode} 冷恢复先校验容量，拒绝时不改历史或运行时，失败初始化可释放并重试`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'whycode-model-switch-'))
      const resolved = resolveModelConnection(config(), alternativeId)
      assert.equal(resolved.ok, true)
      if (!resolved.ok) return
      const { entry, providerConfig } = resolved.value
      const target = { ...entry, capabilities: { ...entry.capabilities, contextWindow: 64_000, maxOutput: 4_000 } }
      const workspace: WorkspaceBinding = mode === 'ssh'
        ? { mode: 'ssh', target: 'test-server', label: '测试服务器', workingDirectory: '/project' }
        : localWorkspace(root)
      const runtime = new DesktopSessionRuntime({ workspace, modelId: selectedId, reasoningEffort: 'high', emit: () => {} })
      try {
        const store = new SessionStore(root)
        const journal = await store.create({ workspace, modelId: selectedId, reasoningEffort: 'high' })
        runtime.journal = journal
        await journal.recordSnapshot('compact', [
          { role: 'user', content: 'x'.repeat(280_000) },
          { role: 'assistant', content: '原有回答' },
        ])
        let disposed = 0
        const createSession = async (recorder: SessionJournal) => {
          const session = new AgentSession({
            model: target, providerConfig,
            promptContext: { projectDir: root, osPlatform: process.platform },
            sessionRecorder: recorder, emit: event => runtime.emit(event),
            requestApproval: async () => ({ approved: false }),
          })
          const dispose = session.dispose.bind(session)
          session.dispose = async () => { disposed++; await dispose() }
          return session
        }
        await assert.rejects(selectRuntimeModel(runtime, target, providerConfig, createSession), /当前上下文超过目标模型的可用容量/)
        assert.equal(runtime.modelId, selectedId)
        assert.equal(runtime.reasoningEffort, 'high')
        assert.deepEqual(runtime.contextUsage, null)
        assert.equal(runtime.session, null)
        assert.equal(runtime.sessionInitialization, null)
        assert.equal(runtime.busy, false)
        assert.equal(disposed, 1)
        assert.equal(journal.metadataSnapshot.modelId, selectedId)
        assert.equal((await store.open(journal.sessionId)).metadataSnapshot.modelId, selectedId)

        await journal.recordSnapshot('compact', [{ role: 'user', content: '已手动压缩的摘要' }])
        await selectRuntimeModel(runtime, target, providerConfig, createSession)
        assert.equal(runtime.modelId, target.id)
        assert.equal(runtime.reasoningEffort, 'default')
        assert.equal(journal.metadataSnapshot.modelId, target.id)
        assert.equal((await store.open(journal.sessionId)).metadataSnapshot.modelId, target.id)
        assert.ok(runtime.session)
        assert.equal((runtime as DesktopSessionRuntime).contextUsage?.contextWindow, 64_000)
        assert.equal(runtime.workStartedAt, null)
      } finally {
        await runtime.dispose()
        await rm(root, { recursive: true, force: true })
      }
    })
  }

  it('已有 Agent 拒绝切换后保留模型与推理强度，新草稿无需加载历史', async () => {
    const resolved = resolveModelConnection(config(), alternativeId)
    assert.equal(resolved.ok, true)
    if (!resolved.ok) return
    const { entry, providerConfig } = resolved.value
    const live = runtime('live').runtime
    live.session!.setModelSelection = async () => { throw new Error('容量不足') }
    const unexpected = async (): Promise<AgentSession> => { throw new Error('不应新建 Agent') }
    await assert.rejects(selectRuntimeModel(live, entry, providerConfig, unexpected), /容量不足/)
    assert.equal(live.modelId, selectedId)
    assert.equal(live.reasoningEffort, 'high')
    const draft = runtime('draft').runtime
    await selectRuntimeModel(draft, entry, providerConfig, unexpected)
    assert.equal(draft.modelId, alternativeId)
    assert.equal(draft.session, null)
    assert.equal(draft.journal, null)
  })
})
