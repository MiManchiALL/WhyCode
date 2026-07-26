import { z } from 'zod'

export const MCP_CONFIG_VERSION = 1

const MCP_DEFAULT_STARTUP_TIMEOUT_MS = 10_000
const MCP_DEFAULT_TOOL_TIMEOUT_MS = 60_000
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u
const HEADER_VALUE_CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/u

const commonServerSchema = {
  enabled: z.boolean().default(true),
  startupTimeoutMs: z.number().int().min(1_000).max(120_000)
    .default(MCP_DEFAULT_STARTUP_TIMEOUT_MS),
  toolTimeoutMs: z.number().int().min(1_000).max(600_000)
    .default(MCP_DEFAULT_TOOL_TIMEOUT_MS),
}

const stdioServerSchema = z.strictObject({
  transport: z.literal('stdio'),
  command: boundedText(4_096),
  args: z.array(boundedText(8_192)).max(64).default([]),
  cwd: boundedText(32_768).optional(),
  env: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
    boundedText(32_768, false),
  ).optional(),
  ...commonServerSchema,
})

const httpServerSchema = z.strictObject({
  transport: z.literal('http'),
  url: boundedText(2_048).refine(isHttpUrl, '必须是无账号密码的 HTTP(S) URL'),
  headers: z.record(
    z.string().min(1).max(256).regex(HEADER_NAME, 'HTTP header 名称无效'),
    boundedText(32_768, false)
      .refine((value) => !HEADER_VALUE_CONTROL.test(value), 'HTTP header 值包含控制字符'),
  ).optional(),
  ...commonServerSchema,
})

const serverSchema = z.discriminatedUnion('transport', [
  stdioServerSchema,
  httpServerSchema,
])

const configSchema = z.strictObject({
  version: z.literal(MCP_CONFIG_VERSION),
  servers: z.record(
    boundedText(128).refine((value) => !CONTROL_CHARACTER.test(value), '名称包含控制字符'),
    serverSchema,
  ),
})

export type ParsedMcpConfig = z.infer<typeof configSchema>
export type ParsedMcpServer = ParsedMcpConfig['servers'][string]
export type McpServerConfigInput = z.input<typeof serverSchema>

export function parseMcpConfig(value: unknown): ParsedMcpConfig {
  return configSchema.parse(value)
}

export function formatMcpConfigError(error: unknown): string {
  if (!(error instanceof z.ZodError)) {
    const message = error instanceof Error ? error.message : String(error)
    return `配置无法解析：${message.replace(/[\r\n]+/gu, ' ').slice(0, 500)}`
  }
  const issue = error.issues[0]
  const location = issue?.path.length ? `（${issue.path.join('.')}）` : ''
  return `配置格式无效${location}：${issue?.message ?? '未知字段错误'}`
}

function boundedText(maxLength: number, trim = true) {
  return z.string().transform((value) => trim ? value.trim() : value).pipe(
    z.string().min(1).max(maxLength),
  )
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username
      && !url.password
    )
  } catch {
    return false
  }
}
