import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { localWorkspace, type AgentSession, type SessionJournal } from '@whycode/core'
import { cliProxyModelId, type WhycodeConfig } from './config.ts'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { listModelConnections, resolveModelConnection } from './model-connections.ts'
import { synchronizeRuntimeModelSelection } from './runtime-model-selection.ts'

const profileId = 'google:gemini-3.8-flash'
const selectedId = cliProxyModelId(profileId)
const alternativeId = 'deepseek:deepseek-v4-flash'

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
