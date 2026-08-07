import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  cliProxyModelId,
  loadConfig,
  migrateLegacyConfig,
  resolveDefaultModelId,
  resolveWebSearchProvider,
  saveConfig,
  type ConfigSecretCodec,
  type WhycodeConfig,
} from './config.ts'

function config(
  providers: WhycodeConfig['providers'],
  defaultModel?: string,
): WhycodeConfig {
  return { providers, defaultModel }
}

const codec: ConfigSecretCodec = {
  isAvailable: () => true,
  encrypt: (secret) => Buffer.from(`safe:${secret}`).toString('base64'),
  decrypt: (payload) => Buffer.from(payload, 'base64').toString().slice(5),
}

describe('默认模型选择', () => {
  it('优先使用配置中指定且已有 key 的内置模型', () => {
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

  it('默认模型不可用时回退到目录中第一个已有 key 的模型', () => {
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

  it('已启用的 CLIProxyAPI 模型可作为显式默认连接', () => {
    const modelId = cliProxyModelId('openai:gpt-5.6-sol')
    const value = config({}, modelId)
    value.cliProxyApi = {
      apiKey: 'proxy-key',
      baseURL: 'http://127.0.0.1:8317/v1',
      modelIds: ['openai:gpt-5.6-sol'],
      modelRoutes: { 'openai:gpt-5.6-sol': 'gpt-5.6-sol' },
    }
    assert.equal(resolveDefaultModelId(value), modelId)
  })

  it('只配置 CLIProxyAPI 时回退到首个已启用的等价型号', () => {
    const value = config({})
    value.cliProxyApi = {
      apiKey: 'proxy-key',
      baseURL: 'http://127.0.0.1:8317/v1',
      modelIds: ['google:gemini-3.1-pro-preview', 'openai:gpt-5.6-sol'],
      modelRoutes: {
        'google:gemini-3.1-pro-preview': 'gemini-pro-agent',
        'openai:gpt-5.6-sol': 'gpt-5.6-sol',
      },
    }
    assert.equal(
      resolveDefaultModelId(value),
      cliProxyModelId('google:gemini-3.1-pro-preview'),
    )
  })

  it('CLIProxyAPI 配置中的退役型号不能恢复为默认模型', () => {
    const modelId = cliProxyModelId('openai:gpt-5.2')
    const value = config({}, modelId)
    value.cliProxyApi = {
      apiKey: 'proxy-key',
      baseURL: 'http://127.0.0.1:8317/v1',
      modelIds: ['openai:gpt-5.2'],
      modelRoutes: { 'openai:gpt-5.2': 'gpt-5.2' },
    }
    assert.equal(resolveDefaultModelId(value), null)
  })

  it('没有任何可用模型时返回 null', () => {
    assert.equal(resolveDefaultModelId(config({})), null)
    assert.equal(resolveDefaultModelId(null), null)
  })
})

describe('网页搜索后端选择', () => {
  it('兼容旧 Perplexity 配置并优先使用显式可用后端', () => {
    assert.equal(resolveWebSearchProvider({
      providers: {},
      webSearch: { perplexity: { apiKey: 'perplexity-key' } },
    }), 'perplexity')
    assert.equal(resolveWebSearchProvider({
      providers: {},
      webSearch: {
        activeProvider: 'tavily',
        perplexity: { apiKey: 'perplexity-key' },
        tavily: { apiKey: 'tavily-key' },
      },
    }), 'tavily')
  })

  it('活动后端缺少密钥时回退到已配置后端', () => {
    assert.equal(resolveWebSearchProvider({
      providers: {},
      webSearch: {
        activeProvider: 'tavily',
        perplexity: { apiKey: 'perplexity-key' },
      },
    }), 'perplexity')
    assert.equal(resolveWebSearchProvider(null), 'perplexity')
  })
})

describe('配置密钥存储', () => {
  it('四档权限偏好均可跨配置重载恢复', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-permission-mode-'))
    const path = join(root, 'config.json')
    try {
      for (const permissionMode of ['readonly', 'default', 'acceptEdits', 'auto'] as const) {
        await saveConfig({ providers: {}, permissionMode }, codec, path)
        assert.equal(loadConfig(path, codec)?.permissionMode, permissionMode)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('保存时不落明文，读取时恢复连接密钥与协商模型引用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-config-'))
    const path = join(root, 'config.json')
    const value: WhycodeConfig = {
      providers: { mimo: { apiKey: 'official-secret' } },
      cliProxyApi: {
        apiKey: 'proxy-secret',
        baseURL: 'http://127.0.0.1:8317/v1',
        modelIds: ['openai:gpt-5.6-sol'],
        modelRoutes: {
          'openai:gpt-5.6-sol': 'gpt-5.6-sol',
          'openai:gpt-5.6-terra': 'gpt-5.6-terra',
        },
      },
      retiredModelLabels: { 'legacy:model': 'Legacy Model' },
      auxiliaryModels: { visionModelId: 'mimo:mimo-v2.5' },
      consensusAgents: {
        B: { modelId: 'mimo:mimo-v2.5' },
      },
      webSearch: {
        activeProvider: 'tavily',
        perplexity: { apiKey: 'perplexity-secret' },
        tavily: { apiKey: 'tavily-secret', searchDepth: 'advanced' },
      },
      permissionMode: 'auto',
      mcpSecretHeaders: [{
        serverName: 'context7',
        connectionFingerprint: 'a'.repeat(64),
        headerName: 'CONTEXT7_API_KEY',
        value: 'context7-secret',
      }],
      mcpOAuthSessions: [{
        serverName: 'github',
        connectionFingerprint: 'b'.repeat(64),
        clientInformation: {
          client_id: 'github-client-id',
          client_secret: 'github-client-secret',
        },
        tokens: {
          access_token: 'github-oauth-token',
          refresh_token: 'github-refresh-token',
          token_type: 'bearer',
        },
      }],
    }
    try {
      await saveConfig(value, codec, path)
      const raw = await readFile(path, 'utf-8')
      assert.doesNotMatch(
        raw,
        /official-secret|proxy-secret|perplexity-secret|tavily-secret|context7-secret|github-client-secret|github-oauth-token|github-refresh-token/,
      )
      const loaded = loadConfig(path, codec)
      assert.equal(loaded?.providers.mimo?.apiKey, 'official-secret')
      assert.equal(loaded?.cliProxyApi?.apiKey, 'proxy-secret')
      assert.deepEqual(loaded?.cliProxyApi?.modelIds, ['openai:gpt-5.6-sol'])
      assert.deepEqual(loaded?.cliProxyApi?.modelRoutes, {
        'openai:gpt-5.6-sol': 'gpt-5.6-sol',
        'openai:gpt-5.6-terra': 'gpt-5.6-terra',
      })
      assert.equal(loaded?.retiredModelLabels?.['legacy:model'], 'Legacy Model')
      assert.deepEqual(loaded?.auxiliaryModels, { visionModelId: 'mimo:mimo-v2.5' })
      assert.deepEqual(loaded?.consensusAgents?.B, { modelId: 'mimo:mimo-v2.5' })
      assert.equal(loaded?.webSearch?.activeProvider, 'tavily')
      assert.equal(loaded?.webSearch?.perplexity?.apiKey, 'perplexity-secret')
      assert.equal(loaded?.webSearch?.tavily?.apiKey, 'tavily-secret')
      assert.equal(loaded?.webSearch?.tavily?.searchDepth, 'advanced')
      assert.equal(loaded?.permissionMode, 'auto')
      assert.deepEqual(loaded?.mcpSecretHeaders, [{
        serverName: 'context7',
        connectionFingerprint: 'a'.repeat(64),
        headerName: 'CONTEXT7_API_KEY',
        value: 'context7-secret',
      }])
      assert.deepEqual(loaded?.mcpOAuthSessions, [{
        serverName: 'github',
        connectionFingerprint: 'b'.repeat(64),
        clientInformation: {
          client_id: 'github-client-id',
          client_secret: 'github-client-secret',
        },
        tokens: {
          access_token: 'github-oauth-token',
          refresh_token: 'github-refresh-token',
          token_type: 'bearer',
        },
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('单个损坏的 MCP OAuth 状态 fail-closed，不影响其它有效连接', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-config-oauth-'))
    const path = join(root, 'config.json')
    const validPayload = {
      tokens: {
        access_token: 'valid-access-token',
        token_type: 'bearer',
      },
    }
    try {
      await writeFile(path, JSON.stringify({
        version: 7,
        providers: {},
        mcpOAuthSessions: [
          {
            serverName: 'github',
            connectionFingerprint: 'a'.repeat(64),
            encryptedPayload: codec.encrypt(JSON.stringify(validPayload)),
          },
          {
            serverName: 'damaged',
            connectionFingerprint: 'b'.repeat(64),
            encryptedPayload: codec.encrypt('not-json'),
          },
        ],
      }))
      assert.deepEqual(loadConfig(path, codec)?.mcpOAuthSessions, [{
        serverName: 'github',
        connectionFingerprint: 'a'.repeat(64),
        ...validPayload,
      }])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('JSON 中显式填写的新 key 优先于旧加密字段', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-config-'))
    const path = join(root, 'config.json')
    try {
      await writeFile(path, JSON.stringify({
        providers: {
          mimo: { apiKey: 'json-key', encryptedApiKey: codec.encrypt('old-key') },
        },
      }))
      assert.equal(loadConfig(path, codec)?.providers.mimo?.apiKey, 'json-key')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('启动迁移一次完成明文加密、旧自定义与旧协商连接删除和历史型号留名', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-config-migration-'))
    const path = join(root, 'config.json')
    try {
      await writeFile(path, JSON.stringify({
        version: 3,
        providers: { mimo: { apiKey: 'legacy-secret' } },
        defaultModel: 'custom:old-proxy',
        customConnections: [{
          id: 'old-proxy',
          name: 'CLIProxyAPI',
          modelId: 'gpt-5.6-sol(high)',
          apiKey: 'removed-custom-secret',
        }],
        consensusAgents: {
          B: { model: 'mimo:mimo-v2.5', apiKey: 'legacy-peer-secret' },
        },
      }))
      assert.equal(await migrateLegacyConfig(codec, path), true)
      const raw = await readFile(path, 'utf-8')
      assert.doesNotMatch(raw, /legacy-secret|legacy-peer-secret|removed-custom-secret|customConnections|"apiKey"/)
      const loaded = loadConfig(path, codec)
      assert.equal(loaded?.providers.mimo?.apiKey, 'legacy-secret')
      assert.equal(loaded?.consensusAgents, undefined)
      assert.equal(loaded?.defaultModel, undefined)
      assert.equal(
        loaded?.retiredModelLabels?.['custom:old-proxy'],
        'gpt-5.6-sol(high)',
      )
      assert.equal(loaded?.retiredModelLabels?.['openai:gpt-5.2'], 'GPT-5.2')
      assert.equal(await migrateLegacyConfig(codec, path), false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('v8 升级时直接删除 B/C 的独立端点与密钥，不生成备份字段', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-config-v8-consensus-'))
    const path = join(root, 'config.json')
    try {
      const bEncrypted = codec.encrypt('old-b-secret')
      const cEncrypted = codec.encrypt('old-c-secret')
      await writeFile(path, JSON.stringify({
        version: 8,
        providers: {},
        consensusAgents: {
          B: {
            model: 'deepseek:deepseek-v4-flash',
            baseURL: 'https://old-b.example/v1',
            encryptedApiKey: bEncrypted,
          },
          C: {
            model: 'google:gemini-3.6-flash',
            baseURL: 'https://old-c.example/v1',
            encryptedApiKey: cEncrypted,
          },
        },
      }))

      assert.equal(await migrateLegacyConfig(codec, path), true)
      const raw = await readFile(path, 'utf-8')
      assert.doesNotMatch(raw, /old-b\.example|old-c\.example|old-b-secret|old-c-secret|encryptedApiKey/)
      assert.equal(raw.includes(bEncrypted), false)
      assert.equal(raw.includes(cEncrypted), false)
      assert.equal(loadConfig(path, codec)?.consensusAgents, undefined)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('v4 CLIProxyAPI 只迁移型号选择，不猜测当前实例的实际路由', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-config-v4-'))
    const path = join(root, 'config.json')
    try {
      await writeFile(path, JSON.stringify({
        version: 4,
        providers: {},
        cliProxyApi: {
          apiKey: 'proxy-secret',
          baseURL: 'http://127.0.0.1:8317/v1',
          modelIds: ['google:gemini-3.1-pro-preview'],
        },
      }))
      assert.equal(await migrateLegacyConfig(codec, path), true)
      const loaded = loadConfig(path, codec)
      assert.deepEqual(loaded?.cliProxyApi?.modelIds, ['google:gemini-3.1-pro-preview'])
      assert.deepEqual(loaded?.cliProxyApi?.modelRoutes, {})
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('v5 配置升级安全存储结构时不重复执行旧模型目录迁移', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-config-v5-'))
    const path = join(root, 'config.json')
    try {
      await writeFile(path, JSON.stringify({
        version: 5,
        providers: {},
      }))
      assert.equal(await migrateLegacyConfig(codec, path), true)
      const loaded = loadConfig(path, codec)
      assert.equal(loaded?.retiredModelLabels?.['openai:gpt-5.2'], undefined)
      assert.equal(await migrateLegacyConfig(codec, path), false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('配置解析拒绝数组伪装，并只接受已注册厂商与型号', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-config-shape-'))
    const path = join(root, 'config.json')
    try {
      await writeFile(path, JSON.stringify({ providers: [] }))
      assert.equal(loadConfig(path), null)
      await writeFile(path, JSON.stringify({
        version: 5,
        providers: {
          unknown: { apiKey: 'ignored' },
          mimo: { apiKey: 'valid' },
        },
        cliProxyApi: {
          apiKey: 'proxy',
          baseURL: 'http://127.0.0.1:8317/v1',
          modelIds: [
            'unknown:model',
            'google:gemini-3.6-flash',
            'openai:gpt-5.6-sol',
          ],
          modelRoutes: {
            'google:gemini-3.6-flash': 'gemini-3-flash-agent',
            'openai:gpt-5.6-sol': 'gpt-5.6-sol',
            'openai:gpt-5.6-terra': 'gpt-5.6-terra',
          },
        },
        webSearch: {
          activeProvider: 'unknown',
          perplexity: { apiKey: 'legacy-search-key' },
          tavily: { apiKey: '' },
        },
        permissionMode: 'untrusted-mode',
      }))
      const loaded = loadConfig(path)
      assert.ok(loaded)
      assert.equal(Object.getPrototypeOf(loaded.providers), null)
      assert.equal('unknown' in loaded.providers, false)
      assert.equal(loaded.providers.mimo?.apiKey, 'valid')
      assert.deepEqual(loaded.cliProxyApi?.modelIds, [
        'google:gemini-3.6-flash',
        'openai:gpt-5.6-sol',
      ])
      assert.deepEqual(loaded.cliProxyApi?.modelRoutes, {
        'openai:gpt-5.6-sol': 'gpt-5.6-sol',
        'openai:gpt-5.6-terra': 'gpt-5.6-terra',
      })
      assert.equal(loaded.webSearch?.activeProvider, 'perplexity')
      assert.equal(loaded.webSearch?.perplexity?.apiKey, 'legacy-search-key')
      assert.equal(loaded.webSearch?.tavily, undefined)
      assert.equal(loaded.permissionMode, undefined)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

})
