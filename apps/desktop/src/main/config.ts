import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getModelEntry, MODEL_REGISTRY } from '@whycode/core'

/**
 * M1 阶段的配置读取：~/.whycode/config.json（不入库）。
 * settings UI 落地后迁移到 Electron safeStorage（文档一 [待规划]）。
 *
 * 格式：
 * {
 *   "providers": {
 *     "anthropic": { "apiKey": "sk-...", "baseURL": "可选" },
 *     "deepseek": { "apiKey": "sk-..." },
 *     "mimo": { "apiKey": "sk-...", "baseURL": "可选" }
 *   },
 *   "defaultModel": "anthropic:claude-sonnet-4-6",
 *   "consensusAgents": {                          // M3：协商评审员 B/C（Main 永远 = 顶栏当前模型）
 *     "B": { "model": "deepseek:deepseek-v4-flash", "apiKey": "sk-...", "baseURL": "可选" },
 *     "C": { ... }
 *   }
 * }
 */
export interface ConsensusAgentConfig {
  model: string
  apiKey: string
  baseURL?: string
}

export interface WhycodeConfig {
  providers: Record<string, { apiKey: string; baseURL?: string }>
  defaultModel?: string
  consensusAgents?: Partial<Record<'B' | 'C', ConsensusAgentConfig>>
}

export function getConfigPath(): string {
  return join(homedir(), '.whycode', 'config.json')
}

export function loadConfig(): WhycodeConfig | null {
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw) as WhycodeConfig
    if (!parsed.providers || typeof parsed.providers !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function hasConfiguredKey(config: WhycodeConfig | null, modelId: string): boolean {
  if (!config) return false
  try {
    return Boolean(config.providers[getModelEntry(modelId).provider]?.apiKey)
  } catch {
    return false
  }
}

/** 配置指定的可用模型优先，否则按注册表顺序选择第一个已配置 key 的模型。 */
export function resolveDefaultModelId(config: WhycodeConfig | null): string | null {
  if (config?.defaultModel && hasConfiguredKey(config, config.defaultModel)) {
    return config.defaultModel
  }
  return MODEL_REGISTRY.find((model) => hasConfiguredKey(config, model.id))?.id ?? null
}

/** M3：评审员 B/C 都配置了 model+key 才允许开启协商（Main 永远用当前会话模型，上下文天然连续） */
export function consensusAgentsReady(config: WhycodeConfig | null): boolean {
  const agents = config?.consensusAgents
  if (!agents) return false
  return (['B', 'C'] as const).every((id) => Boolean(agents[id]?.apiKey && agents[id]?.model))
}
