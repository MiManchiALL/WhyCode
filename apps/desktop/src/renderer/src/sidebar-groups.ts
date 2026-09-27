import type { SidebarProject } from '../../shared/projects.ts'
import type { SessionListItem } from '../../shared/session.ts'

export function groupSidebarSessions(sessions: readonly SessionListItem[], projects: readonly SidebarProject[]) {
  const pinned: SessionListItem[] = []
  const recent: SessionListItem[] = []
  const byProject = new Map(projects.map(project => [project.id, [] as SessionListItem[]]))
  const membership = new Map(projects.flatMap(project => project.sessionIds.map(id => [id, project.id] as const)))
  for (const session of sessions) {
    if (session.pinned) pinned.push(session)
    else {
      const group = byProject.get(membership.get(session.sessionId) ?? '')
      if (group) group.push(session)
      else recent.push(session)
    }
  }
  return { pinned, recent, byProject }
}
