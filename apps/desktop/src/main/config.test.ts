import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveDefaultModelId, type WhycodeConfig } from './config.ts'

function config(
  providers: WhycodeConfig['providers'],
  defaultModel?: string,
): WhycodeConfig {
  return { providers, defaultModel }
}

describe('默认模型选择', () => {
  it('优先使用配置中指定且已有 key 的模型', () => {
    assert.equal(
      resolveDefaultModelId(config(
        {
          anthropic: { apiKey: 'anthropic-key' },
          deepseek: { apiKey: 'deepseek-key' },
        },
        'deepseek:deepseek-v4-flash',
      )),
      'deepseek:deepseek-v4-flash',
    )
  })

  it('默认模型不可用时回退到注册表中第一个已有 key 的模型', () => {
    assert.equal(
      resolveDefaultModelId(config(
        { deepseek: { apiKey: 'deepseek-key' } },
        'anthropic:claude-sonnet-4-6',
      )),
      'deepseek:deepseek-v4-flash',
    )
    assert.equal(
      resolveDefaultModelId(config(
        { anthropic: { apiKey: 'anthropic-key' } },
        'unknown:model',
      )),
      'anthropic:claude-sonnet-4-6',
    )
  })

  it('没有任何可用模型时返回 null', () => {
    assert.equal(resolveDefaultModelId(config({})), null)
    assert.equal(resolveDefaultModelId(null), null)
  })
})
