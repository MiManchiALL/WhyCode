import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * M1 阶段的配置读取：~/.whycode/config.json（不入库）。
 * settings UI 落地后迁移到 Electron safeStorage（文档一 [待规划]）。
 *
 * 格式：
 * {
 *   "providers": {
 *     "anthropic": { "apiKey": "sk-...", "baseURL": "可选" },
 *     "deepseek": { "apiKey": "sk-..." }
 *   },
 *   "defaultModel": "anthropic:claude-sonnet-4-6",
 *   "consensusAgents": {                          // M3：每 Agent 独立模型配置，三者齐备才开启协商
 *     "Main": { "model": "deepseek:deepseek-v4-flash", "apiKey": "sk-...", "baseURL": "可选" },
 *     "B": { ... }, "C": { ... }
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
  consensusAgents?: Partial<Record<'Main' | 'B' | 'C', ConsensusAgentConfig>>
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

/** M3：Main/B/C 三者都配置了 model+key 才允许开启协商（文档一 §3.6）；模型 ID 有效性由调用方对注册表校验 */
export function consensusAgentsReady(config: WhycodeConfig | null): boolean {
  const agents = config?.consensusAgents
  if (!agents) return false
  return (['Main', 'B', 'C'] as const).every((id) => Boolean(agents[id]?.apiKey && agents[id]?.model))
}
