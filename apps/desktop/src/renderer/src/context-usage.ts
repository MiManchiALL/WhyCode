import type { ContextUsageInfo } from '@whycode/core/events'

export interface ContextUsagePresentation {
  percent: number
  usedTokens: number
  contextWindow: number
  autoCompactThreshold: number
  autoCompactPending: boolean
  segments: Array<{
    key: 'system' | 'tools' | 'messages'
    width: number
  }>
}

const SEGMENT_KEYS = [
  ['system', 'systemPromptTokens'],
  ['tools', 'toolTokens'],
  ['messages', 'messageTokens'],
] as const

export function contextUsagePresentation(
  usage: ContextUsageInfo,
): ContextUsagePresentation | null {
  if (!Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return null
  const usedTokens = nonNegative(usage.usedTokens)
  const contextWindow = Math.max(1, Math.round(usage.contextWindow))
  const autoCompactThreshold = Math.min(
    contextWindow,
    nonNegative(usage.autoCompactThreshold),
  )
  const percent = Math.min(100, Math.round(usedTokens / contextWindow * 100))
  const parts = SEGMENT_KEYS.map(([key, field]) => ({
    key,
    tokens: nonNegative(usage.breakdown[field]),
  }))
  const partTotal = parts.reduce((sum, part) => sum + part.tokens, 0)
  const segments = partTotal === 0
    ? percent > 0 ? [{ key: 'messages' as const, width: percent }] : []
    : parts
        .map((part) => ({
          key: part.key,
          width: percent * part.tokens / partTotal,
        }))
        .filter((part) => part.width > 0)
  return {
    percent,
    usedTokens,
    contextWindow,
    autoCompactThreshold,
    autoCompactPending: autoCompactThreshold > 0 && usedTokens >= autoCompactThreshold,
    segments,
  }
}

export function formatContextTokens(tokens: number): string {
  const normalized = nonNegative(tokens)
  if (normalized < 1_000) return String(normalized)
  if (normalized >= 1_000_000) {
    const millions = normalized / 1_000_000
    const digits = millions < 100 && !Number.isInteger(millions) ? 1 : 0
    return `${millions.toFixed(digits)}M`
  }
  const thousands = normalized / 1_000
  const digits = thousands < 100 && !Number.isInteger(thousands) ? 1 : 0
  return `${thousands.toFixed(digits)}K`
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}
