import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getModelEntry } from '@whycode/core'
import {
  CLI_PROXY_MODEL_COMPATIBILITY,
  cliProxyModelEntries,
  getDefaultCliProxyRoute,
  getCliProxyEffectiveCapabilities,
  isCliProxyRoute,
  resolveCliProxyRoutes,
} from './cli-proxy-models.ts'

describe('CLIProxyAPI 独立模型兼容目录', () => {
  it('只登记逐项核对过的 Claude、Gemini 与 GPT 型号', () => {
    const providers = new Set(cliProxyModelEntries().map(({ entry }) => entry.provider))
    assert.deepEqual([...providers], ['anthropic', 'google', 'openai'])
    assert.equal(
      new Set(CLI_PROXY_MODEL_COMPATIBILITY.map((item) => item.profileId)).size,
      CLI_PROXY_MODEL_COMPATIBILITY.length,
    )
    const routes = CLI_PROXY_MODEL_COMPATIBILITY.flatMap((item) =>
      item.routes.map((route) => route.modelId))
    assert.equal(new Set(routes).size, routes.length)
  })

  it('每条审核路由都只能收窄厂商画像并产生自洽的有效画像', () => {
    for (const compatibility of CLI_PROXY_MODEL_COMPATIBILITY) {
      const official = getModelEntry(compatibility.profileId).capabilities
      for (const route of compatibility.routes) {
        const effective = getCliProxyEffectiveCapabilities(
          compatibility.profileId,
          route.modelId,
        )!
        assert.ok(effective.contextWindow <= official.contextWindow)
        assert.ok(effective.maxOutput <= official.maxOutput)
        assert.ok(!effective.supportsNativeTools || official.supportsNativeTools)
        assert.ok(!effective.supportsImageInput || official.supportsImageInput)
        assert.ok(
          effective.supportsOriginalImageDetail !== true
          || official.supportsOriginalImageDetail === true,
        )
        if (effective.reasoningEffort) {
          assert.ok(official.reasoningEffort)
          assert.ok(effective.reasoningEffort.supported.every(
            (level) => official.reasoningEffort!.supported.includes(level),
          ))
          assert.ok(effective.reasoningEffort.supported.includes(
            effective.reasoningEffort.default,
          ))
        }
      }
    }
  })

  it('保留规范路由并明确登记已审核的 Gemini Antigravity 路由', () => {
    assert.equal(
      getDefaultCliProxyRoute('anthropic:claude-sonnet-4-6'),
      'claude-sonnet-4-6',
    )
    assert.equal(
      getDefaultCliProxyRoute('google:gemini-3.1-pro-preview'),
      'gemini-3.1-pro-preview',
    )
    assert.equal(
      isCliProxyRoute('google:gemini-3.1-pro-preview', 'gemini-pro-agent'),
      true,
    )
    assert.equal(
      getDefaultCliProxyRoute('google:gemini-3.7-flash'),
      'gemini-3.7-flash-high',
    )
  })

  it('只从当前实例实际公布的候选中选路由', () => {
    assert.deepEqual(resolveCliProxyRoutes(
      ['google:gemini-3.1-pro-preview', 'openai:gpt-5.6-sol'],
      new Set(['gemini-pro-agent', 'gpt-5.6-sol']),
    ), {
      'google:gemini-3.1-pro-preview': 'gemini-pro-agent',
      'openai:gpt-5.6-sol': 'gpt-5.6-sol',
    })
    assert.deepEqual(resolveCliProxyRoutes(
      ['google:gemini-3.1-pro-preview'],
      new Set(['gemini-3-flash-agent']),
    ), {})
  })

  it('用 CLIProxyAPI 路由约束收窄厂商画像而不改写厂商目录', () => {
    const official = getModelEntry('openai:gpt-5.6-sol').capabilities
    const proxy = getCliProxyEffectiveCapabilities(
      'openai:gpt-5.6-sol',
      'gpt-5.6-sol',
    )
    assert.equal(official.contextWindow, 1_050_000)
    assert.equal(official.reasoningEffort?.supported.includes('none'), true)
    assert.equal(proxy?.contextWindow, 372_000)
    assert.equal(proxy?.maxOutput, 128_000)
    assert.equal(proxy?.structuredOutput, 'tool-based')
    assert.equal(proxy?.supportsImageInput, true)
    assert.equal(proxy?.supportsOriginalImageDetail, undefined)
    assert.deepEqual(proxy?.reasoningEffort, {
      supported: ['low', 'medium', 'high', 'xhigh', 'max'],
      default: 'low',
    })
  })

  it('按实际路由保留不同默认档位并使用更严格的上下文上限', () => {
    assert.equal(
      getCliProxyEffectiveCapabilities(
        'anthropic:claude-sonnet-4-6',
        'claude-sonnet-4-6',
      )?.contextWindow,
      200_000,
    )
    assert.equal(
      getCliProxyEffectiveCapabilities(
        'google:gemini-3.1-pro-preview',
        'gemini-pro-agent',
      )?.reasoningEffort?.default,
      'high',
    )
    assert.equal(
      getCliProxyEffectiveCapabilities(
        'google:gemini-3.1-pro-preview',
        'gemini-3.1-pro-low',
      )?.reasoningEffort?.default,
      'low',
    )
    assert.deepEqual(
      getCliProxyEffectiveCapabilities(
        'google:gemini-3.7-flash',
        'gemini-3.7-flash-high',
      )?.reasoningEffort,
      { supported: ['low', 'medium', 'high'], default: 'high' },
    )
  })

  it('不接受未审核厂商或近似路由名称', () => {
    assert.equal(getDefaultCliProxyRoute('openai:gpt-5.2'), null)
    assert.equal(getDefaultCliProxyRoute('deepseek:deepseek-v4-flash'), null)
    assert.equal(getDefaultCliProxyRoute('deepseek:deepseek-v4-pro'), null)
    assert.equal(
      isCliProxyRoute('google:gemini-3.7-flash', 'gemini-3.7-flash'),
      false,
    )
    assert.equal(
      getCliProxyEffectiveCapabilities('openai:gpt-5.6-sol', 'gpt-5.6'),
      null,
    )
  })
})
