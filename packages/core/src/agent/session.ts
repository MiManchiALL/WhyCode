import { streamText, type ModelMessage } from 'ai'
import type { CoreEvent, StopReason, UsageInfo } from '../events.ts'
import type { ModelEntry, ProviderConfig } from '../providers/registry.ts'
import { buildSystemPrompt, type PromptContext } from '../prompts/system.ts'

/**
 * Agent 会话：M1-b 版本（纯文本对话，无工具）。
 *
 * 设计对齐文档二 §5.1：async generator 状态机，每轮 = 一次流式模型调用；
 * M1-c 接入工具后，这里扩展为「响应含 tool_use 则执行工具并续轮」的完整循环。
 * 自愈（重试/降级）后续在循环内实现，不抛异常终止会话。
 */
export interface AgentSessionOptions {
  model: ModelEntry
  providerConfig: ProviderConfig
  promptContext: PromptContext
}

export class AgentSession {
  private messages: ModelMessage[] = []
  private options: AgentSessionOptions

  constructor(options: AgentSessionOptions) {
    this.options = options
  }

  setModel(model: ModelEntry, providerConfig: ProviderConfig): void {
    this.options = { ...this.options, model, providerConfig }
  }

  /** 处理一条用户消息，yield CoreEvent 流。宿主用 for await 消费。 */
  async *run(userText: string, abortSignal: AbortSignal): AsyncGenerator<CoreEvent> {
    const turnId = crypto.randomUUID()
    this.messages.push({ role: 'user', content: userText })

    yield { type: 'turn-start', turnId }
    yield { type: 'agent-status', status: 'working' }

    let stopReason: StopReason = 'completed'
    const usage: UsageInfo = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
    }

    try {
      const languageModel = this.options.model.create(this.options.providerConfig)
      const result = streamText({
        model: languageModel,
        system: buildSystemPrompt(this.options.promptContext),
        messages: this.messages,
        abortSignal,
      })

      let assistantText = ''
      let thinkingStartedAt: number | null = null
      let emittedThinking = false

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'reasoning-delta': {
            if (thinkingStartedAt === null) {
              thinkingStartedAt = Date.now()
              yield { type: 'agent-status', status: 'thinking' }
            }
            emittedThinking = true
            yield { type: 'thinking-delta', text: part.text }
            break
          }
          case 'reasoning-end': {
            if (emittedThinking && thinkingStartedAt !== null) {
              yield { type: 'thinking-end', durationMs: Date.now() - thinkingStartedAt }
              yield { type: 'agent-status', status: 'working' }
              thinkingStartedAt = null
              emittedThinking = false
            }
            break
          }
          case 'text-delta': {
            assistantText += part.text
            yield { type: 'text-delta', text: part.text }
            break
          }
          case 'finish': {
            usage.inputTokens = part.totalUsage.inputTokens ?? 0
            usage.outputTokens = part.totalUsage.outputTokens ?? 0
            usage.cachedInputTokens =
              part.totalUsage.inputTokenDetails.cacheReadTokens ?? 0
            break
          }
          case 'error': {
            throw part.error instanceof Error
              ? part.error
              : new Error(String(part.error))
          }
          case 'abort': {
            stopReason = 'aborted'
            break
          }
          default:
            break
        }
      }

      // reasoning 流被 abort 等原因截断时补齐 thinking-end
      if (emittedThinking && thinkingStartedAt !== null) {
        yield { type: 'thinking-end', durationMs: Date.now() - thinkingStartedAt }
      }

      if (assistantText) {
        this.messages.push({ role: 'assistant', content: assistantText })
      }
    } catch (error) {
      if (abortSignal.aborted) {
        stopReason = 'aborted'
      } else {
        stopReason = 'error'
        yield {
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        }
      }
    }

    yield { type: 'turn-end', turnId, usage, stopReason }
    yield { type: 'agent-status', status: stopReason === 'error' ? 'error' : 'idle' }
  }
}
