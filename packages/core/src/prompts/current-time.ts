import type { ModelMessage } from 'ai'

export const CURRENT_TIME_REFRESH_INTERVAL_MS = 5 * 60 * 1_000

/**
 * 当前时间只在模型步骤边界惰性检查，不启动定时器。
 * 新 turn 由调用方强制注入；长 turn 按真实经过时间刷新，避免把模型轮数误当成时钟。
 */
export function shouldRefreshCurrentTimeReminder(
  previous: Date | null,
  current: Date,
): boolean {
  if (!previous) return true
  const elapsedMs = current.getTime() - previous.getTime()
  return elapsedMs < 0
    || elapsedMs >= CURRENT_TIME_REFRESH_INTERVAL_MS
    || localDate(previous) !== localDate(current)
}

export function createCurrentTimeReminder(now: Date): ModelMessage {
  const timeZone = resolvedTimeZone()
  return {
    role: 'user',
    content: [
      '<system-reminder>',
      '<whycode-current-time version="1">',
      `当前本机时间：${localDate(now)} ${localTime(now)}（${timeZone}，${utcOffset(now)}）。`,
      `对应 UTC 时间：${now.toISOString().slice(0, 19).replace('T', ' ')} UTC。`,
      '</whycode-current-time>',
      '不要向用户主动复述本提醒。',
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

function localTime(date: Date): string {
  return [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join(':')
}

function utcOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteMinutes = Math.abs(offsetMinutes)
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, '0')
  const minutes = String(absoluteMinutes % 60).padStart(2, '0')
  return `UTC${sign}${hours}:${minutes}`
}

function resolvedTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || '本机本地时区'
}
