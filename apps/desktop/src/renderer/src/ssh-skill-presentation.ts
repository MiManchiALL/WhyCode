import type { SshSkillJob, SshSkillResult, SshSkillRow } from '../../shared/ssh-skills.ts'

export type SshSkillItem =
  | { id: string; row: SshSkillRow; result?: SshSkillResult }
  | { id: string; row?: undefined; result: SshSkillResult }

export const canSyncSkill = (row: SshSkillRow) => row.local && (row.status === 'missing' || row.status === 'update')

export function sshSkillItems(rows: SshSkillRow[], job: SshSkillJob | undefined, mode: 'sync' | 'clean', showExisting: boolean): SshSkillItem[] {
  const results = new Map(job?.results.map(result => [result.id, result]))
  const items: SshSkillItem[] = []
  for (const row of rows) {
    const result = results.get(row.id)
    results.delete(row.id)
    const visible = mode === 'clean' ? row.managed : row.local && (showExisting || canSyncSkill(row))
    if (visible || result) items.push({ id: row.id, row, result })
  }
  // 清理后目录项可能已消失；只投影最近任务的结果，不另外保存历史目录。
  for (const result of results.values()) items.push({ id: result.id, result })
  return items
}
