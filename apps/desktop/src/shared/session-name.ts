export const MAX_SESSION_NAME_LENGTH = 200

export interface RenameSessionRequest { sessionId: string; name: string }
export type RenameSessionResult = { ok: true } | { ok: false; error: string }

export function normalizeSessionName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('会话名称无效')
  const name = value.trim()
  if (!name) throw new Error('会话名称不能为空')
  if (name.length > MAX_SESSION_NAME_LENGTH) throw new Error(`会话名称不能超过 ${MAX_SESSION_NAME_LENGTH} 个字符`)
  if (/[\r\n\u0000]/u.test(name)) throw new Error('会话名称不能包含换行或空字符')
  return name
}
