import type { SubagentProfile, SubagentStatus, SubagentSummary } from '@whycode/core'

export type SubagentPanelPage =
  | { kind: 'overview' }
  | { kind: 'transcript'; subagentId: string }

export type ResolvedSubagentPanelPage =
  | { kind: 'overview'; title: '子代理' }
  | { kind: 'transcript'; title: string; subagent: SubagentSummary }

const STATUS_LABELS: Record<SubagentStatus, string> = {
  running: '运行中',
  completed: '已完成',
  error: '失败',
  aborted: '已停止',
  limit: '达到上限',
  refusal: '已拒绝',
}

const PROFILE_LABELS: Record<SubagentProfile, string> = {
  explore: 'Explore',
  reviewer: 'Reviewer',
  general: 'General',
}

export function subagentStatusLabel(status: SubagentStatus): string {
  return STATUS_LABELS[status]
}

export function isSubagentRunning(status: SubagentStatus): boolean {
  return status === 'running'
}

export function subagentProfileLabel(profile: SubagentProfile): string {
  return PROFILE_LABELS[profile]
}

/** 标题和正文从同一页面事实解析；无有效标题时不得回退显示其它内容。 */
export function resolveSubagentPanelPage(
  page: SubagentPanelPage | null,
  subagents: readonly SubagentSummary[],
): ResolvedSubagentPanelPage | null {
  if (!page) return null
  if (page.kind === 'overview') return { kind: 'overview', title: '子代理' }
  const subagent = subagents.find((item) => item.id === page.subagentId)
  return subagent
    ? { kind: 'transcript', title: subagent.name, subagent }
    : null
}
