import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import {
  providerOptionsWithReasoningEffort,
  type ModelEntry,
  type ProviderConfig,
} from '@whycode/core'
import { cliProxyModelId, type WhycodeConfig } from './config.ts'
import { getDefaultCliProxyRoute } from './cli-proxy-models.ts'
import {
  listAuxiliaryVisionModelCandidates,
  listConfiguredModelCandidates,
  listModelConnections,
  pruneInvalidAuxiliaryModel,
  pruneInvalidConsensusAgents,
  resolveAuxiliaryVisionModel,
  resolveModelConnection,
} from './model-connections.ts'

describe('模型连接解析', () => {
  it('统一候选只包含当前可解析连接，并清理协商中的失效引用', () => {
    const value: WhycodeConfig = {
      providers: { deepseek: { apiKey: 'key' } },
      consensusAgents: {
        B: { modelId: 'deepseek:deepseek-v4-flash' },
        C: { modelId: 'google:gemini-3.7-flash' },
      },
    }

    assert.deepEqual(listConfiguredModelCandidates(value), [
      { id: 'deepseek:deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
      { id: 'deepseek:deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
    ])
    assert.deepEqual(pruneInvalidConsensusAgents(value).consensusAgents, {
      B: { modelId: 'deepseek:deepseek-v4-flash' },
    })
  })

  it('内置厂商的官方端点与协议兼容中转共用注册模型能力', () => {
    const official = resolveModelConnection(
      config({ anthropic: { apiKey: 'key' } }),
      'anthropic:claude-sonnet-4-6',
    )
    const relay = resolveModelConnection(
      config({ anthropic: { apiKey: 'key', baseURL: 'http://127.0.0.1:8080/v1' } }),
      'anthropic:claude-sonnet-4-6',
    )
    assert.equal(official.ok && official.value.entry.capabilities.supportsImageInput, true)
    assert.equal(relay.ok && relay.value.entry.capabilities.supportsImageInput, true)
  })

  it('CLIProxyAPI 使用独立连接身份并按路由约束合成有效画像', () => {
    const value = withCliProxy(
      ['openai:gpt-5.6-sol'],
      { openai: { apiKey: 'official-key' } },
    )
    const proxyId = cliProxyModelId('openai:gpt-5.6-sol')
    const result = resolveModelConnection(value, proxyId)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.entry.id, proxyId)
      assert.equal(result.value.entry.displayName, 'GPT-5.6 Sol（CLIProxyAPI）')
      assert.equal(result.value.entry.capabilities.contextWindow, 372_000)
      assert.equal(result.value.entry.capabilities.structuredOutput, 'tool-based')
      assert.deepEqual(result.value.entry.capabilities.reasoningEffort, {
        supported: ['low', 'medium', 'high', 'xhigh', 'max'],
        default: 'low',
      })
      assert.deepEqual(result.value.providerConfig, {
        apiKey: 'proxy-key',
        baseURL: 'http://127.0.0.1:8317/v1',
      })
      assert.throws(
        () => providerOptionsWithReasoningEffort(result.value.entry, 'none'),
        /不支持推理强度 none/,
      )
      const created = result.value.entry.create(result.value.providerConfig)
      assert.notEqual(typeof created, 'string')
      if (typeof created !== 'string') assert.equal(created.modelId, 'gpt-5.6-sol')
    }

    const names = listModelConnections(value)
      .filter((item) => item.id.endsWith('openai:gpt-5.6-sol'))
      .map((item) => item.displayName)
    assert.deepEqual(names, ['GPT-5.6 Sol', 'GPT-5.6 Sol（CLIProxyAPI）'])
  })

  it('CLIProxyAPI 的三种协议统一映射 AgentSession 身份，官方连接不透传', async () => {
    const transportSessionId = '11111111-1111-4111-8111-111111111111'
    const cases = [
      ['anthropic:claude-sonnet-4-6', { anthropic: { apiKey: 'official-key' } }],
      ['google:gemini-3.7-flash', { google: { apiKey: 'official-key' } }],
      ['openai:gpt-5.6-sol', { openai: { apiKey: 'official-key' } }],
    ] as const

    for (const [profileId, providers] of cases) {
      const proxy = resolveModelConnection(
        withCliProxy([profileId]),
        cliProxyModelId(profileId),
      )
      const official = resolveModelConnection(config(providers), profileId)
      assert.equal(proxy.ok, true, profileId)
      assert.equal(official.ok, true, profileId)
      if (!proxy.ok || !official.ok) continue

      assert.equal(
        await captureTransportSessionHeader(
          proxy.value.entry,
          proxy.value.providerConfig,
          transportSessionId,
        ),
        transportSessionId,
        profileId,
      )
      assert.equal(
        await captureTransportSessionHeader(
          official.value.entry,
          official.value.providerConfig,
          transportSessionId,
        ),
        undefined,
        profileId,
      )
    }
  })

  it('CLIProxyAPI 不接受未启用或未注册的模型', () => {
    const value = withCliProxy(
      ['google:gemini-3.1-pro-preview', 'openai:gpt-5.6-sol'],
      {},
      {
        'anthropic:claude-sonnet-4-6': 'claude-sonnet-4-6',
        'openai:gpt-5.6-sol': 'gpt-5.6-sol',
      },
    )
    const disabled = resolveModelConnection(
      value,
      cliProxyModelId('anthropic:claude-sonnet-4-6'),
    )
    assert.equal(disabled.ok, false)
    if (!disabled.ok) assert.match(disabled.error, /尚未启用 Claude Sonnet 4.6/)

    const unpublished = resolveModelConnection(
      value,
      cliProxyModelId('google:gemini-3.1-pro-preview'),
    )
    assert.equal(unpublished.ok, false)
    if (!unpublished.ok) assert.match(unpublished.error, /实例没有公布 Gemini 3.1 Pro Preview/)

    const otherProvider = resolveModelConnection(
      value,
      cliProxyModelId('deepseek:deepseek-v4-pro'),
    )
    assert.equal(otherProvider.ok, false)
    if (!otherProvider.ok) assert.match(otherProvider.error, /尚未适配 DeepSeek V4 Pro/)

    const unknown = resolveModelConnection(value, cliProxyModelId('unknown:model'))
    assert.equal(unknown.ok, false)
    if (!unknown.ok) assert.match(unknown.error, /已不再支持模型/)
  })

  it('退役模型只作为当前历史红色占位，不自动解析为替代型号', () => {
    const value = config({ google: { apiKey: 'key' } })
    value.retiredModelLabels = { 'custom:old-route': 'legacy-model(high)' }
    const retiredId = 'custom:old-route'
    const resolution = resolveModelConnection(value, retiredId)
    assert.equal(resolution.ok, false)
    if (!resolution.ok) {
      assert.match(resolution.error, /WhyCode 已不再支持模型/)
      assert.match(resolution.error, /历史对话仍会保留/)
    }

    const item = listModelConnections(value, retiredId).at(-1)
    assert.equal(item?.id, retiredId)
    assert.equal(item?.displayName, 'legacy-model(high)')
    assert.equal(item?.available, false)
    assert.equal(item?.retired, true)
    assert.equal(
      listModelConnections(value).some((candidate) => candidate.id === retiredId),
      false,
    )
    assert.equal(
      listModelConnections(value, 'google:gemini-3.1-pro-preview')
        .some((candidate) => candidate.id === retiredId),
      false,
    )
  })

  it('当前仍受支持但未启用的 CLIProxyAPI 历史不是退役型号', () => {
    const modelId = cliProxyModelId('google:gemini-3.1-pro-preview')
    const item = listModelConnections(config({}), modelId).at(-1)
    assert.equal(item?.displayName, 'Gemini 3.1 Pro Preview（CLIProxyAPI）')
    assert.equal(item?.available, false)
    assert.equal(item?.retired, false)
    assert.match(item?.unavailableReason ?? '', /尚未启用/)
  })

  it('CLIProxyAPI 使用官方目录登记的 Gemini 3.7 Antigravity 路由', () => {
    const profileId = 'google:gemini-3.7-flash'
    const modelId = cliProxyModelId(profileId)
    const value = withCliProxy(
      [profileId],
      {},
      { [profileId]: 'gemini-3.7-flash-high' },
    )
    const resolution = resolveModelConnection(value, modelId)
    assert.equal(resolution.ok, true)
    if (resolution.ok) {
      const created = resolution.value.entry.create(resolution.value.providerConfig)
      assert.notEqual(typeof created, 'string')
      if (typeof created !== 'string') {
        assert.equal(created.modelId, 'gemini-3.7-flash-high')
      }
    }

    const item = listModelConnections(value).find((model) => model.id === modelId)
    assert.equal(item?.displayName, 'Gemini 3.7 Flash（CLIProxyAPI）')
    assert.equal(item?.available, true)
    assert.equal(item?.retired, false)
    assert.equal(item?.reasoningEffort?.default, 'high')
  })

  it('模型列表只暴露逐型号验证过的推理档位', () => {
    const item = listModelConnections(
      withCliProxy(['google:gemini-3.1-pro-preview']),
    ).find((candidate) => candidate.id === cliProxyModelId('google:gemini-3.1-pro-preview'))
    assert.deepEqual(item?.reasoningEffort, {
      supported: ['low', 'medium', 'high'],
      default: 'high',
    })
  })

  it('CLIProxyAPI 连接按所选型号和协议生成实际推理参数', () => {
    const cases = [
      ['anthropic:claude-sonnet-4-6', 'max', 'anthropic', 'effort'],
      ['google:gemini-3.1-pro-preview', 'high', 'google', 'reasoningEffort'],
      ['google:gemini-3.7-flash', 'medium', 'google', 'reasoningEffort'],
      ['openai:gpt-5.6-sol', 'xhigh', 'openai', 'reasoningEffort'],
    ] as const
    const value = withCliProxy(cases.map(([modelId]) => modelId))

    for (const [baseModelId, effort, providerKey, optionKey] of cases) {
      const result = resolveModelConnection(value, cliProxyModelId(baseModelId))
      assert.equal(result.ok, true, baseModelId)
      if (!result.ok) continue
      const options = providerOptionsWithReasoningEffort(result.value.entry, effort)
      assert.equal(options?.[providerKey]?.[optionKey], effort, baseModelId)
    }
  })

  it('普通模型下拉列表只返回已经配置并可用的连接', () => {
    const models = listModelConnections(config({ google: { apiKey: 'key' } }))
    assert.deepEqual(new Set(models.map((model) => model.id)), new Set([
      'google:gemini-3.1-pro-preview',
      'google:gemini-3.7-flash',
    ]))
    assert.equal(models.every((model) => model.available), true)
  })

  it('辅助识图让文字模型获得独立图片路由，视觉模型仍保持原生路由', () => {
    const value: WhycodeConfig = {
      providers: {
        deepseek: { apiKey: 'text-key' },
        google: { apiKey: 'vision-key' },
      },
      auxiliaryModels: { visionModelId: 'google:gemini-3.7-flash' },
    }
    assert.deepEqual(listAuxiliaryVisionModelCandidates(value).map((model) => model.id), [
      'google:gemini-3.1-pro-preview',
      'google:gemini-3.7-flash',
    ])
    assert.equal(resolveAuxiliaryVisionModel(value)?.entry.id, 'google:gemini-3.7-flash')
    const models = listModelConnections(value)
    assert.equal(
      models.find((model) => model.id === 'deepseek:deepseek-v4-flash')?.imageInputMode,
      'auxiliary',
    )
    assert.equal(
      models.find((model) => model.id === 'google:gemini-3.7-flash')?.imageInputMode,
      'native',
    )

    delete value.providers.google
    assert.equal(resolveAuxiliaryVisionModel(value), null)
    assert.equal(pruneInvalidAuxiliaryModel(value).auxiliaryModels, undefined)
    assert.equal(
      listModelConnections(value)[0]?.imageInputMode,
      'none',
    )
  })
})

function config(providers: WhycodeConfig['providers']): WhycodeConfig {
  return { providers }
}

function withCliProxy(
  modelIds: string[],
  providers: WhycodeConfig['providers'] = {},
  modelRoutes: Record<string, string> = Object.fromEntries(
    modelIds.flatMap((modelId) => {
      const route = getDefaultCliProxyRoute(modelId)
      return route ? [[modelId, route]] : []
    }),
  ),
): WhycodeConfig {
  return {
    providers,
    cliProxyApi: {
      apiKey: 'proxy-key',
      baseURL: 'http://127.0.0.1:8317/v1',
      modelIds,
      modelRoutes,
    },
  }
}

async function captureTransportSessionHeader(
  entry: ModelEntry,
  providerConfig: ProviderConfig,
  transportSessionId: string,
): Promise<string | undefined> {
  let header: string | undefined
  const server = createServer(async (request, response) => {
    const value = request.headers['x-session-id']
    header = Array.isArray(value) ? value[0] : value
    for await (const _chunk of request) {
      // Drain the request before replying so every provider observes a normal HTTP exchange.
    }
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'request captured', type: 'test' } }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address() as AddressInfo
    const model = entry.create({
      ...providerConfig,
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    }, { transportSessionId })
    assert.notEqual(typeof model, 'string')
    if (typeof model !== 'string') {
      await assert.rejects(async () => model.doGenerate({
        prompt: [{
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        }],
      }))
    }
    return header
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
}
