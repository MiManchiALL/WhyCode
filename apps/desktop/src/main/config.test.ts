import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadConfig,
  migratePlaintextSecrets,
  resolveDefaultModelId,
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

  it('识别 providers.mimo 中配置的 MiMo V2.5 密钥', () => {
    assert.equal(
      resolveDefaultModelId(
        config({ mimo: { apiKey: 'mimo-key' } }, 'mimo:mimo-v2.5'),
      ),
      'mimo:mimo-v2.5',
    )
  })

  it('支持通过检测的自定义连接作为默认模型', () => {
    const value = config({}, 'custom:local-mimo')
    value.customConnections = [{
      id: 'local-mimo',
      name: '本地 MiMo',
      protocol: 'openai-chat',
      baseURL: 'http://localhost/v1',
      apiKey: 'custom-key',
      modelId: 'MiMo - V2.5',
      probe: { text: 'supported', tools: 'supported', image: 'supported' },
      checkedAt: '2026-07-16T00:00:00.000Z',
    }]
    assert.equal(resolveDefaultModelId(value), 'custom:local-mimo')
  })

  it('不会把仅文本可用、但工具未通过的连接选为 Agent 默认模型', () => {
    const value = config({ mimo: { apiKey: 'fallback-key' } }, 'custom:chat-only')
    value.customConnections = [{
      id: 'chat-only',
      name: '仅聊天端点',
      protocol: 'openai-chat',
      baseURL: 'http://localhost/v1',
      apiKey: 'custom-key',
      modelId: 'chat-only',
      probe: { text: 'supported', tools: 'unknown', image: 'unknown' },
      checkedAt: '2026-07-16T00:00:00.000Z',
    }]
    assert.equal(resolveDefaultModelId(value), 'mimo:mimo-v2.5')
  })
})

describe('配置密钥存储', () => {
  it('保存时不落明文，读取时恢复官方、自定义和协商密钥', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-config-'))
    const path = join(root, 'config.json')
    const codec: ConfigSecretCodec = {
      isAvailable: () => true,
      encrypt: (secret) => Buffer.from(`safe:${secret}`).toString('base64'),
      decrypt: (payload) => Buffer.from(payload, 'base64').toString().slice(5),
    }
    const value: WhycodeConfig = {
      providers: { mimo: { apiKey: 'official-secret' } },
      customConnections: [{
        id: 'custom-one',
        name: '自定义',
        protocol: 'openai-chat',
        baseURL: 'http://localhost/v1',
        apiKey: 'custom-secret',
        modelId: 'model-one',
        probe: { text: 'supported', tools: 'supported', image: 'unknown' },
        checkedAt: '2026-07-16T00:00:00.000Z',
      }],
      consensusAgents: {
        B: { model: 'mimo:mimo-v2.5', apiKey: 'peer-secret' },
      },
    }
    try {
      await saveConfig(value, codec, path)
      const raw = await readFile(path, 'utf-8')
      assert.doesNotMatch(raw, /official-secret|custom-secret|peer-secret/)
      assert.equal(loadConfig(path, codec)?.providers.mimo?.apiKey, 'official-secret')
      assert.equal(loadConfig(path, codec)?.customConnections?.[0]?.apiKey, 'custom-secret')
      assert.equal(loadConfig(path, codec)?.consensusAgents?.B?.apiKey, 'peer-secret')
      value.providers.mimo = { apiKey: 'rotated-secret' }
      await saveConfig(value, codec, path)
      assert.equal(loadConfig(path, codec)?.providers.mimo?.apiKey, 'rotated-secret')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('JSON 中显式填写的新 key 优先于旧加密字段，便于下一次安全迁移', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-config-'))
    const path = join(root, 'config.json')
    const codec: ConfigSecretCodec = {
      isAvailable: () => true,
      encrypt: (secret) => Buffer.from(secret).toString('base64'),
      decrypt: (payload) => Buffer.from(payload, 'base64').toString(),
    }
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

  it('启动迁移会原子移除旧配置中的明文 key，并保留可解密值', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-config-migration-'))
    const path = join(root, 'config.json')
    const codec: ConfigSecretCodec = {
      isAvailable: () => true,
      encrypt: (secret) => Buffer.from(`safe:${secret}`).toString('base64'),
      decrypt: (payload) => Buffer.from(payload, 'base64').toString().slice(5),
    }
    try {
      await writeFile(path, JSON.stringify({
        providers: { mimo: { apiKey: 'legacy-secret' } },
        consensusAgents: {
          B: { model: 'mimo:mimo-v2.5', apiKey: 'legacy-peer-secret' },
        },
      }))
      assert.equal(await migratePlaintextSecrets(codec, path), true)
      const raw = await readFile(path, 'utf-8')
      assert.doesNotMatch(raw, /legacy-secret|legacy-peer-secret|"apiKey"/)
      assert.equal(loadConfig(path, codec)?.providers.mimo?.apiKey, 'legacy-secret')
      assert.equal(loadConfig(path, codec)?.consensusAgents?.B?.apiKey, 'legacy-peer-secret')
      assert.equal(await migratePlaintextSecrets(codec, path), false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('配置解析拒绝数组伪装，并隔离特殊 provider 属性', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-config-shape-'))
    const path = join(root, 'config.json')
    try {
      await writeFile(path, JSON.stringify({ providers: [] }))
      assert.equal(loadConfig(path), null)
      await writeFile(path, '{"providers":{"__proto__":{"apiKey":"ignored"},"mimo":{"apiKey":"valid"}}}')
      const loaded = loadConfig(path)
      assert.ok(loaded)
      assert.equal(Object.getPrototypeOf(loaded.providers), null)
      assert.equal(loaded.providers.mimo?.apiKey, 'valid')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
