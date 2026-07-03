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
 *   "defaultModel": "anthropic:claude-sonnet-4-6"
 * }
 */
export interface WhycodeConfig {
  providers: Record<string, { apiKey: string; baseURL?: string }>
  defaultModel?: string
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
