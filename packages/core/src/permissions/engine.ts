import { isAbsolute, resolve } from 'node:path'
import type { ToolDefinition } from '../tools/tool.ts'
import type { PermissionContext, PermissionDecision } from './types.ts'
import {
  findOutsideBoundary,
  findSuspiciousWindowsPattern,
  isSensitivePath,
} from './path-safety.ts'

/**
 * 权限判定引擎（M2-b，M3 增讨论档）。判定链顺序不可交换（文档一 §3.2 / Claude Code 不变式）：
 * 可疑路径拒绝 → 敏感路径强制审批 → 越界审批（讨论档拒绝） → 讨论档规则 → 只读档拦写 → 会话 allow 规则 → 模式快速通道 → 默认策略。
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
  if (def.kind === 'edit' || def.kind === 'execute') {
    for (const p of rawPaths) {
      const abs = isAbsolute(p) ? resolve(p) : resolve(projectDir, p)
      if (isSensitivePath(abs)) {
        return { behavior: 'ask', reason: `涉及敏感路径：${p}` }
      }
    }
  }

  // 3. 工作区边界：越界 → 审批 + add-dir 建议；讨论档直接拒绝（B/C 不得申请漫游授权）
  for (const p of rawPaths) {
    const outside = findOutsideBoundary(p, projectDir, ctx.additionalDirs)
    if (outside) {
      if (ctx.discussion) {
        return { behavior: 'deny', reason: `讨论阶段不可访问工作区之外的路径：${outside}` }
      }
      return {
        behavior: 'ask',
        reason: `路径超出项目目录：${outside}`,
        suggestion: { kind: 'add-dir', dir: outside },
      }
    }
  }

  // 3.5 讨论档（M3 协议 §11.1 / §14.4）：读放行；写只许 scratch；scratch 内命令自动放行。
  // 相对路径必须先按执行语义（projectDir 基准）绝对化，再对 scratch 边界检查——否则相对路径会被误判在 scratch 内
  if (ctx.discussion) {
    if (def.kind === 'read' || def.kind === 'control') return { behavior: 'allow' }
    const scratchDir = ctx.discussion.scratchDir
    const outsideScratch = rawPaths
      .map((p) => {
        const abs = isAbsolute(p) ? resolve(p) : resolve(projectDir, p)
        return findOutsideBoundary(abs, scratchDir, [])
      })
      .find((p) => p !== null)
    if (def.kind === 'edit') {
      return outsideScratch
        ? {
            behavior: 'deny',
            reason: `讨论阶段禁止修改原项目或工作区外文件（${outsideScratch}），实验文件请写入你的临时工作区：${ctx.discussion.scratchDir}`,
          }
        : { behavior: 'allow' }
    }
    // execute：全部路径都在 scratch 内 → 自动放行；涉及外部路径或未显式指定 scratch cwd → 审批（不提供记住建议）
    if (rawPaths.length > 0 && !outsideScratch) return { behavior: 'allow' }
    return {
      behavior: 'ask',
      reason: outsideScratch
        ? `讨论阶段命令涉及临时工作区之外的路径：${outsideScratch}`
        : '讨论阶段命令未限定在临时工作区内（请显式传 cwd 为你的 scratch 目录）',
    }
  }

  // 4. 只读档：一切非读操作直接拒绝
  if (ctx.mode === 'readonly' && def.kind !== 'read' && def.kind !== 'control') {
    return { behavior: 'deny', reason: '当前为只读模式，不允许修改或执行' }
  }

  // 5. 读操作：边界内一律放行
  if (def.kind === 'read' || def.kind === 'control') return { behavior: 'allow' }

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
