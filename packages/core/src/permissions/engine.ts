import { isAbsolute, resolve } from 'node:path'
import type { ToolDefinition } from '../tools/tool.ts'
import type { PermissionContext, PermissionDecision } from './types.ts'
import {
  findOutsideBoundary,
  findSuspiciousWindowsPattern,
  isSensitivePath,
} from './path-safety.ts'

/**
 * 返回工具首次隐私审批对本次调用的拦截决定；null 表示继续走常规权限链。
 *
 * 全自动是用户对当前会话的显式授权，不产生任何首次授权请求。
 */
export function checkInitialToolApproval(
  def: ToolDefinition,
  ctx: PermissionContext,
): PermissionDecision | null {
  if (!def.initialApprovalReason || ctx.mode === 'auto') return null
  if (ctx.sessionAllowedTools.includes(def.name)) return null
  return {
    behavior: 'ask',
    reason: def.initialApprovalReason,
    suggestion: { kind: 'allow-tool', toolName: def.name },
  }
}

/**
 * 权限判定引擎（M2-b，M3 增讨论档）。判定链顺序不可交换（文档一 §3.2）：
 * 可疑路径拒绝 → Main 全自动放行 → 敏感路径审批 → 越界审批（讨论档拒绝） → 讨论档规则 → 只读档拦写 → 会话 allow 规则 → 默认策略。
 * 可疑 Windows 路径永远拒绝；讨论 Agent 的 scratch 边界也不受 Main 全自动档放宽。
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

  // 全自动的契约是零授权弹窗；保留不可审批的可疑路径拒绝，但其余操作直接放行。
  // 讨论 Agent 仍使用独立的 scratch 边界，不能借 Main 的档位获得项目写权限。
  if (ctx.mode === 'auto' && !ctx.discussion) return { behavior: 'allow' }

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
    // execute：全部路径都在 scratch 内 → 自动放行；其它档位请求审批，全自动档直接拒绝，
    // 从而同时满足“零审批弹窗”和讨论 Agent 不得越过 scratch 的边界。
    if (rawPaths.length > 0 && !outsideScratch) return { behavior: 'allow' }
    const reason = outsideScratch
      ? `讨论阶段命令涉及临时工作区之外的路径：${outsideScratch}`
      : '讨论阶段命令未限定在临时工作区内（请显式传 cwd 为你的 scratch 目录）'
    if (ctx.mode === 'auto') return { behavior: 'deny', reason }
    return {
      behavior: 'ask',
      reason,
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
