import {
  getModelEntry,
  type ModelCapabilities,
  type ModelEntry,
  type ReasoningEffort,
  type ReasoningEffortCapability,
} from '@whycode/core'

export interface CliProxyRouteCapabilityConstraints {
  /** CLIProxyAPI 路由实际开放的最大上下文；只能收窄厂商画像。 */
  maxContextWindow?: number
  /** CLIProxyAPI 路由实际开放的最大输出；只能收窄厂商画像。 */
  maxOutputTokens?: number
  supportsNativeTools?: boolean
  supportsImageInput?: boolean
  supportsOriginalImageDetail?: boolean
  reasoningEffort?: {
    /** 路由明确接受的闭集；与厂商档位取交集。 */
    supported: readonly ReasoningEffort[]
    /** 省略时沿用厂商默认；路由有独立默认时必须明确记录。 */
    default?: ReasoningEffort
  }
  /** 路由能保证的最高结构化输出档位。 */
  structuredOutputAtMost?: ModelCapabilities['structuredOutput']
}

export interface CliProxyModelRoute {
  modelId: string
  constraints: CliProxyRouteCapabilityConstraints
}

export interface CliProxyModelCompatibility {
  profileId: string
  /**
   * 同一真实型号在不同 CLIProxyAPI OAuth 通道中可能使用不同路由名。
   * 这里只登记已由 CLIProxyAPI 官方内嵌或远程目录明确证明等价的精确路由，
   * 顺序即选择优先级。
   */
  routes: readonly [CliProxyModelRoute, ...CliProxyModelRoute[]]
}

const GPT_5_6_ROUTE_CONSTRAINTS = {
  maxContextWindow: 372_000,
  maxOutputTokens: 128_000,
  supportsNativeTools: true,
  supportsImageInput: true,
  supportsOriginalImageDetail: true,
  structuredOutputAtMost: 'tool-based',
} satisfies CliProxyRouteCapabilityConstraints

/**
 * CLIProxyAPI 兼容目录与厂商模型目录独立维护。
 *
 * 连接保存时必须再与该实例的 `/models` 结果求交集；静态候选只证明型号等价，
 * 不能证明某个用户的 CLIProxyAPI 账号已经开放该路由。能力约束核对自
 * CLIProxyAPI v7.2.78（768b4c49）的 Codex 客户端目录，以及官方远程模型目录
 * 8b32755e（2026-07-21）；标准 `/models` 只用于确认可用 ID，不生成能力画像。
 */
export const CLI_PROXY_MODEL_COMPATIBILITY: readonly CliProxyModelCompatibility[] = [
  {
    profileId: 'anthropic:claude-sonnet-4-6',
    routes: [{
      modelId: 'claude-sonnet-4-6',
      constraints: {
        maxContextWindow: 200_000,
        maxOutputTokens: 64_000,
        reasoningEffort: { supported: ['low', 'medium', 'high', 'max'] },
      },
    }],
  },
  {
    profileId: 'google:gemini-3.1-pro-preview',
    routes: [
      {
        modelId: 'gemini-3.1-pro-preview',
        constraints: {
          maxContextWindow: 1_048_576,
          maxOutputTokens: 65_536,
          reasoningEffort: { supported: ['low', 'medium', 'high'] },
        },
      },
      {
        modelId: 'gemini-pro-agent',
        constraints: {
          maxContextWindow: 1_048_576,
          maxOutputTokens: 65_535,
          reasoningEffort: {
            supported: ['low', 'medium', 'high'],
            default: 'high',
          },
        },
      },
      {
        modelId: 'gemini-3.1-pro-low',
        constraints: {
          maxContextWindow: 1_048_576,
          maxOutputTokens: 65_535,
          reasoningEffort: {
            supported: ['low', 'medium', 'high'],
            default: 'low',
          },
        },
      },
    ],
  },
  {
    profileId: 'google:gemini-3.6-flash',
    routes: [{
      modelId: 'gemini-3.6-flash-high',
      constraints: {
        maxContextWindow: 1_048_576,
        maxOutputTokens: 65_536,
        reasoningEffort: {
          supported: ['minimal', 'low', 'medium', 'high'],
          default: 'high',
        },
      },
    }],
  },
  {
    profileId: 'openai:gpt-5.6-sol',
    routes: [{
      modelId: 'gpt-5.6-sol',
      constraints: {
        ...GPT_5_6_ROUTE_CONSTRAINTS,
        reasoningEffort: {
          supported: ['low', 'medium', 'high', 'xhigh', 'max'],
          default: 'low',
        },
      },
    }],
  },
  {
    profileId: 'openai:gpt-5.6-terra',
    routes: [{
      modelId: 'gpt-5.6-terra',
      constraints: {
        ...GPT_5_6_ROUTE_CONSTRAINTS,
        reasoningEffort: {
          supported: ['low', 'medium', 'high', 'xhigh', 'max'],
          default: 'medium',
        },
      },
    }],
  },
  {
    profileId: 'openai:gpt-5.6-luna',
    routes: [{
      modelId: 'gpt-5.6-luna',
      constraints: {
        ...GPT_5_6_ROUTE_CONSTRAINTS,
        reasoningEffort: {
          supported: ['low', 'medium', 'high', 'xhigh', 'max'],
          default: 'medium',
        },
      },
    }],
  },
  {
    profileId: 'openai:gpt-5.5',
    routes: [{
      modelId: 'gpt-5.5',
      constraints: {
        maxContextWindow: 272_000,
        maxOutputTokens: 128_000,
        supportsNativeTools: true,
        supportsImageInput: true,
        supportsOriginalImageDetail: true,
        reasoningEffort: {
          supported: ['low', 'medium', 'high', 'xhigh'],
          default: 'medium',
        },
        structuredOutputAtMost: 'tool-based',
      },
    }],
  },
] as const

export function cliProxyModelEntries(): Array<{
  compatibility: CliProxyModelCompatibility
  entry: ModelEntry
}> {
  return CLI_PROXY_MODEL_COMPATIBILITY.map((compatibility) => ({
    compatibility,
    entry: getModelEntry(compatibility.profileId),
  }))
}

export function getCliProxyModelCompatibility(
  profileId: string,
): CliProxyModelCompatibility | null {
  return CLI_PROXY_MODEL_COMPATIBILITY.find(
    (compatibility) => compatibility.profileId === profileId,
  ) ?? null
}

export function getDefaultCliProxyRoute(profileId: string): string | null {
  return getCliProxyModelCompatibility(profileId)?.routes[0].modelId ?? null
}

export function isCliProxyRoute(profileId: string, routeModelId: string): boolean {
  return Boolean(getCliProxyModelRoute(profileId, routeModelId))
}

export function getCliProxyEffectiveCapabilities(
  profileId: string,
  routeModelId: string,
): ModelCapabilities | null {
  const route = getCliProxyModelRoute(profileId, routeModelId)
  if (!route) return null
  return constrainCapabilities(getModelEntry(profileId).capabilities, route.constraints)
}

export function resolveCliProxyRoutes(
  profileIds: readonly string[],
  advertisedModelIds: ReadonlySet<string>,
): Record<string, string> {
  const routes: Record<string, string> = {}
  for (const profileId of profileIds) {
    const route = getCliProxyModelCompatibility(profileId)?.routes.find(
      (candidate) => advertisedModelIds.has(candidate.modelId),
    )
    if (route) routes[profileId] = route.modelId
  }
  return routes
}

function getCliProxyModelRoute(
  profileId: string,
  routeModelId: string,
): CliProxyModelRoute | null {
  return getCliProxyModelCompatibility(profileId)?.routes.find(
    (route) => route.modelId === routeModelId,
  ) ?? null
}

function constrainCapabilities(
  base: ModelCapabilities,
  constraints: CliProxyRouteCapabilityConstraints,
): ModelCapabilities {
  const capabilities: ModelCapabilities = {
    ...base,
    supportsNativeTools: base.supportsNativeTools
      && constraints.supportsNativeTools !== false,
    supportsImageInput: base.supportsImageInput
      && constraints.supportsImageInput !== false,
    reasoningEffort: constrainReasoningEffort(base.reasoningEffort, constraints.reasoningEffort),
    structuredOutput: constrainStructuredOutput(
      base.structuredOutput,
      constraints.structuredOutputAtMost,
    ),
    contextWindow: Math.min(
      base.contextWindow,
      constraints.maxContextWindow ?? base.contextWindow,
    ),
    maxOutput: Math.min(
      base.maxOutput,
      constraints.maxOutputTokens ?? base.maxOutput,
    ),
  }
  if (
    base.supportsOriginalImageDetail !== true
    || constraints.supportsOriginalImageDetail === false
  ) {
    delete capabilities.supportsOriginalImageDetail
  }
  return capabilities
}

function constrainReasoningEffort(
  base: ReasoningEffortCapability | undefined,
  constraint: CliProxyRouteCapabilityConstraints['reasoningEffort'],
): ReasoningEffortCapability | undefined {
  if (!base || !constraint) return base
  const supported = base.supported.filter((level) => constraint.supported.includes(level))
  const defaultLevel = constraint.default ?? base.default
  if (supported.length === 0 || !supported.includes(defaultLevel)) {
    throw new Error('CLIProxyAPI 路由推理强度与厂商画像没有有效交集')
  }
  return { supported, default: defaultLevel }
}

function constrainStructuredOutput(
  base: ModelCapabilities['structuredOutput'],
  limit: ModelCapabilities['structuredOutput'] | undefined,
): ModelCapabilities['structuredOutput'] {
  if (!limit) return base
  const levels: readonly ModelCapabilities['structuredOutput'][] = [
    'prompt',
    'json-object',
    'tool-based',
    'json-schema',
  ]
  return levels.indexOf(base) <= levels.indexOf(limit) ? base : limit
}
