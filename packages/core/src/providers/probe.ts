import { randomUUID } from 'node:crypto'
import {
  generateText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ProviderMetadata,
} from 'ai'
import sharp from 'sharp'
import { z } from 'zod'
import type { CapabilityProbeState, CustomConnectionProbe } from './custom.ts'

const PROBE_TOOL_NAME = 'whycode_capability_probe'
const DEFAULT_TIMEOUT_MS = 20_000

export interface CapabilityProbeOutcome {
  state: CapabilityProbeState
  detail: string
}

export interface CustomConnectionProbeReport {
  text: CapabilityProbeOutcome
  tools: CapabilityProbeOutcome
  image: CapabilityProbeOutcome
}

interface VisualChallenge {
  expected: string
  png: Buffer
}

export interface CustomConnectionProbeOptions {
  abortSignal?: AbortSignal
  timeoutMs?: number
  /** 与正式 Agent 请求一致的厂商参数；避免检测通过、正式模式却采用另一行为。 */
  providerOptions?: ProviderMetadata
  /** 测试注入点；正式调用不传。 */
  nonceFactory?: () => string
  /** 测试注入点；正式调用不传。 */
  visualChallengeFactory?: () => Promise<VisualChallenge>
}

/**
 * 使用无用户数据的最小请求依次探测文本、工具和图片。
 * 只有可验证的成功才开放能力；超时、网络错误或含糊回复保持 unknown。
 */
export async function probeCustomConnection(
  model: LanguageModel,
  options: CustomConnectionProbeOptions = {},
): Promise<CustomConnectionProbeReport> {
  const nonceFactory = options.nonceFactory ?? (() => randomUUID().replaceAll('-', ''))
  const text = await probeText(model, nonceFactory(), options)
  if (text.state !== 'supported') {
    const skipped = { state: 'unknown' as const, detail: '文本连接未通过，未继续探测' }
    return { text, tools: skipped, image: skipped }
  }
  const [tools, image] = await Promise.all([
    probeTools(model, nonceFactory(), options),
    probeImage(model, options),
  ])
  return { text, tools, image }
}

export function compactProbeReport(report: CustomConnectionProbeReport): CustomConnectionProbe {
  return {
    text: report.text.state,
    tools: report.tools.state,
    image: report.image.state,
  }
}

async function probeText(
  model: LanguageModel,
  nonce: string,
  options: CustomConnectionProbeOptions,
): Promise<CapabilityProbeOutcome> {
  try {
    const result = await generateText({
      model,
      prompt: `WhyCode connection probe. Reply with this token: ${nonce}`,
      maxOutputTokens: 64,
      maxRetries: 0,
      providerOptions: options.providerOptions,
      abortSignal: probeSignal(options),
    })
    if (!result.text.trim()) return unknown('模型返回了空文本')
    return supported('文本请求成功')
  } catch (error) {
    return errorOutcome(error, '文本请求被端点拒绝')
  }
}

async function probeTools(
  model: LanguageModel,
  nonce: string,
  options: CustomConnectionProbeOptions,
): Promise<CapabilityProbeOutcome> {
  try {
    const result = await generateText({
      model,
      prompt: `Call ${PROBE_TOOL_NAME} exactly once with nonce "${nonce}". Do not answer in text.`,
      tools: {
        [PROBE_TOOL_NAME]: tool({
          description: 'WhyCode harmless capability probe',
          inputSchema: z.object({ nonce: z.string() }),
        }),
      },
      toolChoice: { type: 'tool', toolName: PROBE_TOOL_NAME },
      maxOutputTokens: 128,
      maxRetries: 0,
      providerOptions: options.providerOptions,
      abortSignal: probeSignal(options),
    })
    const call = result.toolCalls.find((candidate) => candidate.toolName === PROBE_TOOL_NAME)
    if (call && isRecord(call.input) && call.input.nonce === nonce) {
      return supported('原生工具调用成功')
    }
    return unknown('端点完成请求，但没有返回可验证的工具调用')
  } catch (error) {
    return errorOutcome(error, '端点拒绝了工具调用')
  }
}

async function probeImage(
  model: LanguageModel,
  options: CustomConnectionProbeOptions,
): Promise<CapabilityProbeOutcome> {
  const challenge = await (options.visualChallengeFactory ?? createVisualChallenge)()
  const messages: ModelMessage[] = [{
    role: 'user',
    content: [
      { type: 'text', text: 'Read the 4-digit code in this image. Reply with only the code.' },
      { type: 'file', data: challenge.png.toString('base64'), mediaType: 'image/png' },
    ],
  }]
  try {
    const result = await generateText({
      model,
      messages,
      maxOutputTokens: 32,
      maxRetries: 0,
      providerOptions: options.providerOptions,
      abortSignal: probeSignal(options),
    })
    const digits = result.text.replace(/\D/g, '')
    if (digits === challenge.expected) return supported('图片识别挑战通过')
    return unknown('端点接收了图片，但没有返回可验证的识别结果')
  } catch (error) {
    return errorOutcome(error, '端点拒绝了图片输入')
  }
}

async function createVisualChallenge(): Promise<VisualChallenge> {
  const expected = String(Math.floor(1_000 + Math.random() * 9_000))
  const svg = Buffer.from(
    `<svg width="320" height="160" xmlns="http://www.w3.org/2000/svg">`
      + '<rect width="100%" height="100%" fill="white"/>'
      + `<text x="160" y="108" text-anchor="middle" font-family="Arial" font-size="92" font-weight="700" fill="black">${expected}</text>`
      + '</svg>',
  )
  return { expected, png: await sharp(svg).png().toBuffer() }
}

function probeSignal(options: CustomConnectionProbeOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  return options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeout])
    : timeout
}

function errorOutcome(error: unknown, rejectedDetail: string): CapabilityProbeOutcome {
  if (isExplicitClientRejection(error)) return { state: 'unsupported', detail: rejectedDetail }
  return unknown(error instanceof Error ? error.message : '连接探测失败')
}

function isExplicitClientRejection(error: unknown): boolean {
  if (!isRecord(error)) return false
  const statusCode = typeof error.statusCode === 'number'
    ? error.statusCode
    : typeof error.status === 'number' ? error.status : null
  // 认证、限流和超时都不能证明能力不受支持；只认定明确的请求格式/媒体拒绝。
  return statusCode === 400
    || statusCode === 413
    || statusCode === 415
    || statusCode === 422
}

function supported(detail: string): CapabilityProbeOutcome {
  return { state: 'supported', detail }
}

function unknown(detail: string): CapabilityProbeOutcome {
  return { state: 'unknown', detail }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
