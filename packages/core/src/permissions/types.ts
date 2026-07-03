/**
 * 权限系统类型（M2-b，设计依据文档一 §3.2）。
 * 两轴：审批策略档位（mode）× 工作区边界（projectDir + additionalDirs）。
 */

export type PermissionMode = 'readonly' | 'default' | 'acceptEdits' | 'auto'

export const PERMISSION_MODES: { id: PermissionMode; label: string }[] = [
  { id: 'readonly', label: '只读' },
  { id: 'default', label: '默认' },
  { id: 'acceptEdits', label: '自动编辑' },
  { id: 'auto', label: '全自动' },
]

export interface PermissionContext {
  mode: PermissionMode
  /** null = 纯聊天模式（无工具，不会走到判定） */
  projectDir: string | null
  /** 用户本会话内授权的额外目录（绝对路径） */
  additionalDirs: string[]
  /** 本会话「记住允许」的整工具名规则 */
  sessionAllowedTools: string[]
}

export function createPermissionContext(projectDir: string | null): PermissionContext {
  return { mode: 'default', projectDir, additionalDirs: [], sessionAllowedTools: [] }
}

/** 判定结果：ask 可携带批准后的持久化建议（由判定层生成，UI 只负责选择回传） */
export type PermissionDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string }
  | { behavior: 'ask'; reason: string; suggestion?: ApprovalSuggestion }

export type ApprovalSuggestion =
  | { kind: 'add-dir'; dir: string }
  | { kind: 'allow-tool'; toolName: string }
