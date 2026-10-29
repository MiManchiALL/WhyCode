import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createWebSearchSettingsSnapshot,
  updateWebSearchSettings,
  updateWebFetchSettings,
} from './web-search-settings.ts'
import type { WhycodeConfig } from './config.ts'

describe('网页搜索设置边界', () => {
  it('快照只暴露是否配置，不返回密钥', () => {
    const snapshot = createWebSearchSettingsSnapshot({
      providers: {},
      webSearch: {
        activeProvider: 'tavily',
        perplexity: { apiKey: 'private-perplexity-key' },
        tavily: {
          apiKey: 'private-tavily-key',
          searchDepth: 'advanced',
        },
      },
    })

    assert.deepEqual(snapshot, {
      activeProvider: 'tavily',
      providers: [
        { id: 'perplexity', displayName: 'Perplexity Search API', hasKey: true },
        {
          id: 'tavily',
          displayName: 'Tavily Search API',
          hasKey: true,
          searchDepth: 'advanced',
        },
        { id: 'deepseek', displayName: 'DeepSeek Search API', hasKey: false },
      ],
    })
    assert.doesNotMatch(JSON.stringify(snapshot), /private-perplexity-key|private-tavily-key/)
  })

  it('分别保存密钥并显式切换当前后端', () => {
    const created = updateWebSearchSettings(null, {
      provider: 'perplexity',
      apiKey: ' first-key ',
    })
    assert.equal(created.webSearch?.perplexity?.apiKey, 'first-key')
    assert.equal(created.webSearch?.activeProvider, 'perplexity')

    const preserved = updateWebSearchSettings(created, { provider: 'perplexity' })
    assert.equal(preserved.webSearch?.perplexity?.apiKey, 'first-key')
    const replaced = updateWebSearchSettings(preserved, {
      provider: 'perplexity',
      apiKey: 'second-key',
    })
    assert.equal(replaced.webSearch?.perplexity?.apiKey, 'second-key')

    const withTavily = updateWebSearchSettings(replaced, {
      provider: 'tavily',
      apiKey: ' tavily-key ',
      searchDepth: 'advanced',
    })
    assert.equal(withTavily.webSearch?.tavily?.apiKey, 'tavily-key')
    assert.equal(withTavily.webSearch?.tavily?.searchDepth, 'advanced')
    assert.equal(withTavily.webSearch?.activeProvider, 'perplexity')

    const activated = updateWebSearchSettings(withTavily, {
      provider: 'tavily',
      setActive: true,
    })
    assert.equal(activated.webSearch?.activeProvider, 'tavily')
    assert.equal(activated.webSearch?.perplexity?.apiKey, 'second-key')
    assert.equal(activated.webSearch?.tavily?.searchDepth, 'advanced')

    const cleared = updateWebSearchSettings(activated, {
      provider: 'tavily',
      clearApiKey: true,
    })
    assert.equal(cleared.webSearch?.tavily, undefined)
    assert.equal(cleared.webSearch?.activeProvider, 'perplexity')

    const empty = updateWebSearchSettings(cleared, {
      provider: 'perplexity',
      clearApiKey: true,
    })
    assert.equal(empty.webSearch, undefined)
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
    assert.throws(
      () => updateWebSearchSettings(null, {
        provider: 'tavily',
        setActive: true,
      }),
      /请先配置 Tavily Search API key/,
    )
    assert.throws(
      () => updateWebSearchSettings(null, {
        provider: 'tavily',
        apiKey: 'key',
        searchDepth: 'unknown' as 'basic',
      }),
      /未知的 Tavily 搜索质量档位/,
    )
    assert.throws(
      () => updateWebSearchSettings(null, {
        provider: 'perplexity',
        apiKey: 'key',
        searchDepth: 'advanced',
      }),
      /只有 Tavily 支持搜索质量档位/,
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

  it('DeepSeek 密钥供搜索和抓取共用，选择抓取不改变搜索后端', () => {
    const initial = updateWebSearchSettings(null, { provider: 'perplexity', apiKey: 'pplx-key' })
    const configured = updateWebSearchSettings(initial, { provider: 'deepseek', apiKey: ' ds-key ' })
    const fetching = updateWebFetchSettings(configured, { provider: 'deepseek' })
    assert.equal(fetching.webSearch?.activeProvider, 'perplexity')
    assert.equal(fetching.webSearch?.deepseek?.apiKey, 'ds-key')
    assert.equal(fetching.webFetch?.provider, 'deepseek')
    assert.equal(configured.webFetch, undefined)
    const searching = updateWebSearchSettings(fetching, { provider: 'deepseek', setActive: true })
    assert.equal(searching.webSearch?.activeProvider, 'deepseek')
    const cleared = updateWebSearchSettings(searching, { provider: 'deepseek', clearApiKey: true })
    assert.equal(cleared.webSearch?.deepseek, undefined)
    assert.equal(cleared.webSearch?.activeProvider, 'perplexity')
    // 保留抓取选择，调用时报缺少密钥，不能静默切换外部服务。
    assert.equal(cleared.webFetch?.provider, 'deepseek')
    assert.equal(updateWebFetchSettings(cleared, { provider: 'builtin' }).webFetch?.provider, 'builtin')
  })

  it('抓取设置拒绝未知后端和无密钥的 DeepSeek', () => {
    assert.throws(() => updateWebFetchSettings(null, { provider: 'unknown' as 'builtin' }), /未知/)
    assert.throws(() => updateWebFetchSettings(null, { provider: 'deepseek' }), /请先配置/)
    assert.equal(updateWebFetchSettings(null, { provider: 'builtin' }).webFetch?.provider, 'builtin')
  })
})
