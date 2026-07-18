import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createWebSearchSettingsSnapshot,
  updateWebSearchSettings,
} from './web-search-settings.ts'
import type { WhycodeConfig } from './config.ts'

describe('网页搜索设置边界', () => {
  it('快照只暴露是否配置，不返回密钥', () => {
    const snapshot = createWebSearchSettingsSnapshot({
      providers: {},
      webSearch: { perplexity: { apiKey: 'private-search-key' } },
    })

    assert.deepEqual(snapshot, {
      provider: 'perplexity',
      displayName: 'Perplexity Search API',
      hasKey: true,
    })
    assert.doesNotMatch(JSON.stringify(snapshot), /private-search-key/)
  })

  it('支持新增、留空保留、替换和清除密钥', () => {
    const created = updateWebSearchSettings(null, {
      provider: 'perplexity',
      apiKey: ' first-key ',
    })
    assert.equal(created.webSearch?.perplexity?.apiKey, 'first-key')

    const preserved = updateWebSearchSettings(created, { provider: 'perplexity' })
    assert.equal(preserved.webSearch?.perplexity?.apiKey, 'first-key')

    const replaced = updateWebSearchSettings(preserved, {
      provider: 'perplexity',
      apiKey: 'second-key',
    })
    assert.equal(replaced.webSearch?.perplexity?.apiKey, 'second-key')

    const cleared = updateWebSearchSettings(replaced, {
      provider: 'perplexity',
      clearApiKey: true,
    })
    assert.equal(cleared.webSearch, undefined)
  })

  it('拒绝来自 IPC 的未知服务和控制字符', () => {
    assert.throws(
      () => updateWebSearchSettings(null, {
        provider: 'unknown' as 'perplexity',
        apiKey: 'key',
      }),
      /未知的网页搜索服务/,
    )
    assert.throws(
      () => updateWebSearchSettings(null, {
        provider: 'perplexity',
        apiKey: 'bad\nkey',
      }),
      /格式无效/,
    )
  })

  it('不修改调用方持有的原配置', () => {
    const initial: WhycodeConfig = {
      providers: {},
      webSearch: { perplexity: { apiKey: 'old-key' } },
    }
    updateWebSearchSettings(initial, {
      provider: 'perplexity',
      apiKey: 'new-key',
    })
    assert.equal(initial.webSearch?.perplexity?.apiKey, 'old-key')
  })
})
