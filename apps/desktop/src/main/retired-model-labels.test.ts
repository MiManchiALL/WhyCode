import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cliProxyModelId, type WhycodeConfig } from './config.ts'
import { syncReferencedRetiredModelLabels } from './retired-model-labels.ts'

describe('历史模型显示名生命周期', () => {
  it('在型号仍受支持时按会话引用保存原名，未使用的型号不生成记录', () => {
    const id = 'google:gemini-3.1-pro-preview'
    const config: WhycodeConfig = { providers: {} }
    assert.equal(syncReferencedRetiredModelLabels(config, new Set()), config)
    const saved = syncReferencedRetiredModelLabels(config, new Set([id, cliProxyModelId(id)]))
    assert.deepEqual(saved.retiredModelLabels, {
      [id]: 'Gemini 3.1 Pro Preview', [cliProxyModelId(id)]: 'Gemini 3.1 Pro Preview（CLIProxyAPI）',
    })
    assert.equal(config.retiredModelLabels, undefined)
    assert.equal(syncReferencedRetiredModelLabels(saved, new Set([id, cliProxyModelId(id)])), saved)
  })

  it('无需源码保存退役型号，最后一个引用消失后移除整个显示名域', () => {
    const id = 'test:retired-model'
    const proxyId = cliProxyModelId(id)
    const config: WhycodeConfig = {
      providers: {},
      retiredModelLabels: { [id]: '历史型号', [proxyId]: '历史路由' },
    }
    assert.equal(syncReferencedRetiredModelLabels(config, new Set([id, proxyId])), config)
    const remaining = syncReferencedRetiredModelLabels(config, new Set([proxyId]))
    assert.deepEqual(remaining.retiredModelLabels, { [proxyId]: '历史路由' })
    assert.equal(syncReferencedRetiredModelLabels(remaining, new Set()).retiredModelLabels, undefined)
    assert.deepEqual(config.retiredModelLabels, { [id]: '历史型号', [proxyId]: '历史路由' })
  })

  it('不为未知型号猜测显示名或生成活动连接', () => {
    const config: WhycodeConfig = { providers: {} }
    for (const id of ['test:unknown-model', '__proto__', 'toString']) {
      assert.equal(syncReferencedRetiredModelLabels(config, new Set([id])), config)
    }
  })
})
