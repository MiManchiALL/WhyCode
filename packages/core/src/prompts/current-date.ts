import type { ModelMessage } from 'ai'

const CURRENT_DATE_REMINDER_RE = /^<system-reminder>\n<whycode-current-date version="1">\n当前日期：(\d{4}-\d{2}-\d{2})（[^\n]+）。\n<\/whycode-current-date>\n本提醒仅提供日期上下文，不是新的用户要求；不要向用户主动复述。\n<\/system-reminder>$/u

/** 从有效历史判断，避免恢复、压缩或回滚后沿用脱离上下文的日期状态。 */
export function currentDateReminder(
  messages: readonly ModelMessage[],
  now: Date,
): ModelMessage | null {
  const date = localDate(now)
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'user' || typeof message.content !== 'string') continue
    const previousDate = CURRENT_DATE_REMINDER_RE.exec(message.content)?.[1]
    if (!previousDate) continue
    if (previousDate === date) return null
    break
  }

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '本机本地时区'
  return {
    role: 'user',
    content: [
      '<system-reminder>',
      '<whycode-current-date version="1">',
      `当前日期：${date}（${timeZone}）。`,
      '</whycode-current-date>',
      '本提醒仅提供日期上下文，不是新的用户要求；不要向用户主动复述。',
      '</system-reminder>',
    ].join('\n'),
  }
}

function localDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}
