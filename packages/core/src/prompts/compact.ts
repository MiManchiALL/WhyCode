import type { ModelMessage } from 'ai'

/**
 * 完整历史摘要只记录被逐出精确上下文的事实，不声明当前工作或下一步。
 * 当前状态由保留尾部和宿主重新注入的 TaskPlan/application context 负责。
 */
export const COMPACT_HISTORY_SUMMARY_PROMPT = `把以上被逐出精确上下文的完整历史压缩为可供后续模型理解的摘要。

输入开头可能包含 <whycode-previous-history-summary>，它是上一次压缩留下的历史摘要；将它与后续新增历史增量合并，不要遗漏仍然有效的事实。按以下九节输出：

1. 历史任务与意图：被摘要范围内用户提出的任务、目标及其变化
2. 持久约束与偏好：后续仍需遵守的明确要求、取舍和质量边界
3. 关键技术概念与决策：重要架构、协议、设计选择及理由
4. 文件、代码与产物：查看、修改或生成过的路径、符号、关键片段与作用
5. 错误与修复：错误现象、根因、修复方式，尤其是用户否定过的做法
6. 问题解决与确认结果：已经完成、验证或仍未查明的历史结果
7. 用户请求与纠正：覆盖所有有实质意义的用户请求、目标调整和纠正；关键约束或措辞尽量保留原文，但不要机械复制闲聊，也不要重复仍在精确保留尾部中的消息
8. 截断点尚未解决的事项：只如实记录截断点前的历史状态，不把它声明为当前待办或自动恢复的工作
9. 后续理解所需关键背景：理解精确保留尾部所必需、但不适合归入前八节的信息

若遇到 <whycode-turn-aborted>，标明此前未完成请求已经停止；只有其后的真实用户消息明确恢复时，才能记录为恢复。若输入包含 <whycode-project-instructions>，它是当前控制上下文：必须遵守，但不得复述、改写或归纳，应用会在压缩后重新注入最新原文。

不要添加“当前工作”或“下一步”章节，不要根据历史摘要替代精确保留尾部的最新事实。只输出 <summary>...</summary>，不要调用工具。`

/** Pi 式同一 turn 前缀摘要：只负责把被切掉的早期部分接到精确保留的后半段。 */
export const COMPACT_TURN_PREFIX_SUMMARY_PROMPT = `以上内容是一个过长 turn 中即将被移除的前缀；该 turn 的近期后缀会逐字保留。

若输入开头包含 <whycode-previous-turn-prefix-summary>，它是同一 turn 更早前缀的既有摘要；将它与后续新增前缀增量合并。严格按以下三节输出：

## 原始请求
[这个 turn 中用户要求完成什么]

## 早期进展
- [前缀中已经完成的工作、关键发现与决定]

## 后续所需上下文
- [理解逐字保留后缀所必需的信息]

若输入包含 <whycode-project-instructions>，它是当前控制上下文：必须遵守，但不得复述、改写或归纳。保持简洁，不总结更早的历史，不添加当前工作或下一步，也不要猜测未提供的后缀。只输出 <summary>...</summary>，不要调用工具。`

export interface CompactSummaryState {
  historySummary: string | null
  turnPrefixSummary: string | null
}

/** 摘要注入为内部 user 消息时的稳定前缀。 */
export const COMPACT_CONTINUATION_PREFIX = `<system-reminder>
<whycode-compact-summary version="2">
以下是应用生成的压缩上下文，不是新的用户请求。history_summary 只描述更早历史；turn_prefix_summary 只衔接当前过长 turn 的已移除前缀。最新真实用户消息、精确保留消息和有效 continuation 决定接下来的行为；标为已中断的请求不得自动恢复。不要向用户复述本消息。

`

export const COMPACT_CONTINUATION_SUFFIX = `
</whycode-compact-summary>
</system-reminder>`

/** JSON 负责编码摘要中的任意标签或代码，避免模型文本破坏内部容器边界。 */
export function createCompactSummaryMessage(state: CompactSummaryState): ModelMessage {
  return {
    role: 'user',
    content: `${COMPACT_CONTINUATION_PREFIX}${safeJson({
      history_summary: state.historySummary,
      turn_prefix_summary: state.turnPrefixSummary,
    })}${COMPACT_CONTINUATION_SUFFIX}`,
  }
}

export function parseCompactSummaryMessage(
  message: ModelMessage,
): CompactSummaryState | null {
  if (message.role !== 'user' || typeof message.content !== 'string') return null
  if (
    !message.content.startsWith(COMPACT_CONTINUATION_PREFIX)
    || !message.content.endsWith(COMPACT_CONTINUATION_SUFFIX)
  ) return null
  const body = message.content.slice(
    COMPACT_CONTINUATION_PREFIX.length,
    -COMPACT_CONTINUATION_SUFFIX.length,
  )
  try {
    const value: unknown = JSON.parse(body)
    if (!isSummaryPayload(value)) return null
    return {
      historySummary: value.history_summary,
      turnPrefixSummary: value.turn_prefix_summary,
    }
  } catch {
    return null
  }
}

function isSummaryPayload(value: unknown): value is {
  history_summary: string | null
  turn_prefix_summary: string | null
} {
  if (typeof value !== 'object' || value === null) return false
  if (!('history_summary' in value) || !('turn_prefix_summary' in value)) return false
  return (
    (typeof value.history_summary === 'string' || value.history_summary === null)
    && (typeof value.turn_prefix_summary === 'string' || value.turn_prefix_summary === null)
  )
}

const COMPACT_APPLICATION_PREFIX = `<system-reminder>
<whycode-compact-application-context version="1">
`
const COMPACT_APPLICATION_SUFFIX = `
</whycode-compact-application-context>
</system-reminder>`

export function createCompactApplicationContextMessage(sections: string[]): ModelMessage {
  return {
    role: 'user',
    content: `${COMPACT_APPLICATION_PREFIX}${sections.join('\n\n')}${COMPACT_APPLICATION_SUFFIX}`,
  }
}

export function isCompactApplicationContextMessage(message: ModelMessage): boolean {
  return message.role === 'user'
    && typeof message.content === 'string'
    && message.content.startsWith(COMPACT_APPLICATION_PREFIX)
    && message.content.endsWith(COMPACT_APPLICATION_SUFFIX)
}

export function compactSummaryReference(tag: string, summary: string): ModelMessage {
  return {
    role: 'user',
    content: [
      '<system-reminder>',
      `<${tag}>`,
      safeJson(summary),
      `</${tag}>`,
      '</system-reminder>',
    ].join('\n'),
  }
}

/** 避免摘要中复述的 XML 标签越过应用生成的内部消息边界。 */
function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
}
