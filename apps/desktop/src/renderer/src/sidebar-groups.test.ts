import assert from 'node:assert/strict'
import { it } from 'node:test'
import { groupSidebarSessions } from './sidebar-groups.ts'
import type { SessionListItem } from '../../shared/session.ts'

const project = { id: 'project', name: '项目', directory: 'E:\\project', sessionIds: ['pinned', 'older', 'newer'] }
const sessions = ['pinned', 'newer', 'recent', 'older'].map(id => ({ sessionId: id, pinned: id === 'pinned' }) as SessionListItem)

it('置顶仅展示一次，项目内会话保持活动时间顺序，未归属会话位于最近', () => {
  const grouped = groupSidebarSessions(sessions, [project])
  assert.deepEqual(grouped.pinned.map(item => item.sessionId), ['pinned'])
  assert.deepEqual(grouped.byProject.get(project.id)?.map(item => item.sessionId), ['newer', 'older'])
  assert.deepEqual(grouped.recent.map(item => item.sessionId), ['recent'])
})

it('移除项目即时释放分组；取消置顶回到所属项目，未知历史不根据路径推测归属', () => {
  assert.deepEqual(groupSidebarSessions(sessions, []).recent.map(item => item.sessionId), ['newer', 'recent', 'older'])
  const unpinned = sessions.map(item => ({ ...item, pinned: false }))
  assert.deepEqual(groupSidebarSessions(unpinned, [project]).byProject.get(project.id)?.map(item => item.sessionId), ['pinned', 'newer', 'older'])
  assert.equal(groupSidebarSessions([], [project]).byProject.size, 1)
})
