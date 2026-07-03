import { isAbsolute, resolve } from 'node:path'
import type { ToolDefinition } from '../tools/tool.ts'
import type { PermissionContext, PermissionDecision } from './types.ts'
import {
  findOutsideBoundary,
  findSuspiciousWindowsPattern,
  isSensitivePath,
} from './path-safety.ts'

/**
 * 权限判定引擎（M2-b）。判定链顺序不可交换（文档一 §3.2 / Claude Code 不变式）：
 * 可疑路径拒绝 → 敏感路径强制审批 → 越界审批 → 只读档拦写 → 会话 allow 规则 → 模式快速通道 → 默认策略。
 * deny 与敏感路径检查永远在任何 allow / 模式放行之前。
 */
export function checkToolPermission(
  def: ToolDefinition,
  input: unknown,
  ctx: PermissionContext,
): PermissionDecision {
  const projectDir = ctx.projectDir
  if (!projectDir) return { behavior: 'deny', reason: '纯聊天模式下无工具可用' }

  const rawPaths = def.extractPaths?.(input as Record<string, unknown>) ?? []

  // 1. Windows 可疑模式：直接拒绝，不给审批机会（防沙箱绕过）
  for (const p of rawPaths) {
    const pattern = findSuspiciousWindowsPattern(p)
    if (pattern) {
      return { behavior: 'deny', reason: `路径包含可疑模式（${pattern}）：${p}` }
    }
  }

  // 2. 敏感路径 + 写操作：强制审批（bypass 免疫，不提供「记住允许」建议）
  if (def.kind !== 'read') {
    for (const p of rawPaths) {
      const abs = isAbsolute(p) ? resolve(p) : resolve(projectDir, p)
      if (isSensitivePath(abs)) {
        return { behavior: 'ask', reason: `涉及敏感路径：${p}` }
      }
    }
  }

  // 3. 工作区边界：越界 → 审批 + add-dir 建议（批准可选择本会话记住该目录）
  for (const p of rawPaths) {
    const outside = findOutsideBoundary(p, projectDir, ctx.additionalDirs)
    if (outside) {
      return {
        behavior: 'ask',
        reason: `路径超出项目目录：${outside}`,
        suggestion: { kind: 'add-dir', dir: outside },
      }
    }
  }

  // 4. 只读档：一切非读操作直接拒绝
  if (ctx.mode === 'readonly' && def.kind !== 'read') {
    return { behavior: 'deny', reason: '当前为只读模式，不允许修改或执行' }
  }

  // 5. 读操作：边界内一律放行
  if (def.kind === 'read') return { behavior: 'allow' }

  // 6. 会话内「记住允许」的工具
  if (ctx.sessionAllowedTools.includes(def.name)) return { behavior: 'allow' }

  // 7. 模式快速通道
  if (ctx.mode === 'auto') return { behavior: 'allow' }
  if (ctx.mode === 'acceptEdits' && def.kind === 'edit') return { behavior: 'allow' }

  // 8. 默认：写/执行类询问，批准可选择本会话记住该工具
  return {
    behavior: 'ask',
    reason: `${def.name} 需要你的确认`,
    suggestion: { kind: 'allow-tool', toolName: def.name },
  }
}
