import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WhycodeConfig } from './config.ts'
import { resolveConsensusAgentSetups } from './consensus-models.ts'

describe('协商评审员模型解析', () => {
  it('B/C 复用统一模型连接的模型与凭据', () => {
    const config: WhycodeConfig = {
      providers: {
        deepseek: { apiKey: 'deepseek-key', baseURL: 'https://gateway.example/v1' },
        google: { apiKey: 'google-key' },
      },
      consensusAgents: {
        B: { modelId: 'deepseek:deepseek-v4-flash' },
        C: { modelId: 'google:gemini-3.6-flash' },
      },
    }

    const result = resolveConsensusAgentSetups(config)

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.value.B.model.id, 'deepseek:deepseek-v4-flash')
    assert.deepEqual(result.value.B.providerConfig, config.providers.deepseek)
    assert.equal(result.value.C.model.id, 'google:gemini-3.6-flash')
    assert.deepEqual(result.value.C.providerConfig, config.providers.google)
  })

  it('缺少选择或连接失效时明确阻止协商', () => {
    assert.deepEqual(resolveConsensusAgentSetups({ providers: {} }), {
      ok: false,
      error: '请先在设置 → 协商模型中为评审员 B/C 选择模型',
    })
    const invalid = resolveConsensusAgentSetups({
      providers: {},
      consensusAgents: {
        B: { modelId: 'deepseek:deepseek-v4-flash' },
        C: { modelId: 'google:gemini-3.6-flash' },
      },
    })
    assert.equal(invalid.ok, false)
    if (!invalid.ok) assert.match(invalid.error, /评审员 B 所选模型不可用/)
  })
})
