import type { SessionListItem } from './session.ts'

export interface SidebarProject {
  id: string
  name: string
  directory: string
  remote?: { connectionId: string; target: string; label: string }
  sessionIds: string[]
}

export interface SessionSidebarSnapshot {
  sessions: SessionListItem[]
  projects: SidebarProject[]
}

export const MAX_PROJECT_NAME_LENGTH = 200

export function normalizeProjectName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('项目名称无效')
  const name = value.trim()
  if (!name || name.length > MAX_PROJECT_NAME_LENGTH || /[\r\n\0]/u.test(name)) {
    throw new Error(`项目名称须为 1～${MAX_PROJECT_NAME_LENGTH} 字符的单行文本`)
  }
  return name
}
