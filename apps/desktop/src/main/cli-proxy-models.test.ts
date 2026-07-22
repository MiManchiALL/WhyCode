import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CLI_PROXY_MODEL_COMPATIBILITY,
  cliProxyModelEntries,
  getCliProxyRoute,
} from './cli-proxy-models.ts'

describe('CLIProxyAPI 独立模型兼容目录', () => {
  it('只登记逐项核对过的 Claude、Gemini 与 GPT 型号', () => {
    const providers = new Set(cliProxyModelEntries().map(({ entry }) => entry.provider))
    assert.deepEqual([...providers], ['anthropic', 'google', 'openai'])
    assert.equal(
      new Set(CLI_PROXY_MODEL_COMPATIBILITY.map((item) => item.profileId)).size,
      CLI_PROXY_MODEL_COMPATIBILITY.length,
    )
  })

  it('使用 CLIProxyAPI 官方注册表中的精确等价路由', () => {
    assert.equal(
      getCliProxyRoute('anthropic:claude-sonnet-4-6'),
      'claude-sonnet-4-6',
    )
    assert.equal(
      getCliProxyRoute('google:gemini-3.1-pro-preview'),
      'gemini-3.1-pro-preview',
    )
    assert.equal(getCliProxyRoute('openai:gpt-5.6-sol'), 'gpt-5.6-sol')
  })

  it('不把旧 Gemini 路由或未注册型号近似映射成新型号', () => {
    assert.equal(getCliProxyRoute('google:gemini-3.6-flash'), null)
    assert.equal(getCliProxyRoute('openai:gpt-5.2'), null)
    assert.equal(getCliProxyRoute('deepseek:deepseek-v4-flash'), null)
  })
})
