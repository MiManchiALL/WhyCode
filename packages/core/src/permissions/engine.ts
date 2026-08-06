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
): Extract<PermissionDecision, { behavior: 'ask' }> | null {
  if (!def.initialApprovalReason || ctx.mode === 'auto') return null
  if (ctx.sessionAllowedTools.includes(def.name)) return null
  return {
    behavior: 'ask',
    reason: def.initialApprovalReason,
    suggestion: { kind: 'allow-tool', toolName: def.name },
  }
}

/**
 * 单一工具授权入口：常规权限中的硬拒绝始终优先于首次隐私审批。
 *
 * 如果同一次调用同时需要首次审批和常规审批，只生成一张审批卡：
 * - 常规的同工具审批由信息更具体的首次审批替代；
 * - 路径/敏感审批与首次审批合并原因，并保留更严格的常规记忆边界。
 */
export function checkToolAuthorization(
  def: ToolDefinition,
  input: unknown,
  ctx: PermissionContext,
): PermissionDecision {
  const permission = checkToolPermission(def, input, ctx)
  if (permission.behavior === 'deny') return permission

  const initial = checkInitialToolApproval(def, ctx)
  if (!initial) return permission
  if (permission.behavior === 'allow') return initial

  if (
    permission.suggestion?.kind === 'allow-tool'
    && initial.suggestion?.kind === 'allow-tool'
    && permission.suggestion.toolName === initial.suggestion.toolName
  ) {
    return initial
  }

  return {
    behavior: 'ask',
    reason: `${permission.reason}；${initial.reason}`,
    ...(permission.suggestion ? { suggestion: permission.suggestion } : {}),
  }
}

/**
 * 权限判定引擎（M2-b，M3 增讨论档）。判定链顺序不可交换（文档一 §3.2）：
 * 可疑路径拒绝 → 无项目能力边界 → Main 全自动放行 → Main 只读硬拒绝 →
 * 讨论档硬边界 → 敏感/越界约束聚合 → 角色/会话/档位策略。
 * 可疑 Windows 路径永远拒绝；讨论 Agent 的 scratch 边界也不受 Main 全自动档放宽。
 */
export function checkToolPermission(
  def: ToolDefinition,
  input: unknown,
  ctx: PermissionContext,
): PermissionDecision {
  const projectDir = ctx.projectDir
  const rawPaths = def.extractPaths?.(input as Record<string, unknown>) ?? []

  // 1. Windows 可疑模式：直接拒绝，不给审批机会（防沙箱绕过）
  for (const p of rawPaths) {
    const pattern = findSuspiciousWindowsPattern(p)
    if (pattern) {
      return { behavior: 'deny', reason: `路径包含可疑模式（${pattern}）：${p}` }
    }
  }

  // 无项目时只允许工具显式声明的能力进入后续判定，权限档位不能扩大工具装配边界。
  if (!projectDir && !def.availableWithoutProject) {
    return { behavior: 'deny', reason: '当前工具需要工作文件夹' }
  }

  // 没有工作文件夹就没有可供用户扩张的本地路径边界；全自动也不能凭空建立边界。
  if (!projectDir && rawPaths.length > 0) {
    return { behavior: 'deny', reason: '当前没有工作文件夹，不能访问本地路径' }
  }

  // 全自动的契约是零授权弹窗；保留不可审批的可疑路径拒绝，但其余操作直接放行。
  // 讨论 Agent 仍使用独立的 scratch 边界，不能借 Main 的档位获得项目写权限。
  if (ctx.mode === 'auto' && !ctx.discussion) return { behavior: 'allow' }

  // 只读是 Main 的硬能力边界，必须先于敏感路径、越界和首次审批，不能产生授权入口。
  if (
    !ctx.discussion
    && ctx.mode === 'readonly'
    && def.kind !== 'read'
    && def.kind !== 'control'
  ) {
    return { behavior: 'deny', reason: '当前为只读模式，不允许修改或执行' }
  }

  if (!projectDir) {
    return checkProjectlessToolPermission(def, ctx)
  }

  const outsidePaths = uniquePaths(rawPaths.flatMap((path) => {
    const outside = findOutsideBoundary(path, projectDir, ctx.additionalDirs)
    return outside ? [outside] : []
  }))
  if (ctx.discussion && outsidePaths.length > 0) {
    return {
      behavior: 'deny',
      reason: `讨论阶段不可访问工作区之外的路径：${describePaths(outsidePaths)}`,
    }
  }

  if (ctx.discussion) {
    const scratchDir = ctx.discussion.scratchDir
    if (def.kind === 'edit' && rawPaths.length === 0) {
      return {
        behavior: 'deny',
        reason: '讨论阶段修改未声明临时工作区内的资源边界',
      }
    }
    const outsideScratch = uniquePaths(rawPaths.flatMap((path) => {
      const abs = isAbsolute(path) ? resolve(path) : resolve(projectDir, path)
      const outside = findOutsideBoundary(abs, scratchDir, [])
      return outside ? [outside] : []
    }))
    if (def.kind === 'edit' && outsideScratch.length > 0) {
      return {
        behavior: 'deny',
        reason: `讨论阶段禁止修改原项目或工作区外文件（${describePaths(outsideScratch)}），实验文件请写入你的临时工作区：${scratchDir}`,
      }
    }
    if (def.kind === 'execute' && (rawPaths.length === 0 || outsideScratch.length > 0)) {
      const reason = outsideScratch.length > 0
        ? `讨论阶段命令涉及临时工作区之外的路径：${describePaths(outsideScratch)}`
        : '讨论阶段命令未限定在临时工作区内（请显式传 cwd 为你的 scratch 目录）'
      return { behavior: 'deny', reason }
    }
  }

  // 敏感、越界和讨论命令审批必须合成同一决定；不能先批准一个条件后顺带放行其它路径。
  const sensitivePaths =
    def.kind === 'edit' || def.kind === 'execute'
      ? uniquePaths(rawPaths.filter((path) => {
          const abs = isAbsolute(path) ? resolve(path) : resolve(projectDir, path)
          return isSensitivePath(abs)
        }))
      : []
  const approvalReasons: string[] = []
  if (sensitivePaths.length > 0) {
    approvalReasons.push(`涉及敏感路径：${describePaths(sensitivePaths)}`)
  }
  if (outsidePaths.length > 0) {
    approvalReasons.push(`路径超出项目目录：${describePaths(outsidePaths)}`)
  }
  if (approvalReasons.length > 0) {
    return {
      behavior: 'ask',
      reason: approvalReasons.join('；'),
      ...(sensitivePaths.length === 0 && outsidePaths.length > 0
        ? { suggestion: { kind: 'add-dir' as const, dir: outsidePaths[0]! } }
        : {}),
    }
  }

  // 3.5 讨论档（M3 协议 §11.1 / §14.4）：上面的硬边界已通过，读和 scratch 内副作用放行。
  if (ctx.discussion) {
    return { behavior: 'allow' }
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

function checkProjectlessToolPermission(
  def: ToolDefinition,
  ctx: PermissionContext,
): PermissionDecision {
  if (def.kind === 'read' || def.kind === 'control') return { behavior: 'allow' }
  if (ctx.sessionAllowedTools.includes(def.name)) return { behavior: 'allow' }
  if (ctx.mode === 'acceptEdits' && def.kind === 'edit') return { behavior: 'allow' }
  return {
    behavior: 'ask',
    reason: `${def.name} 需要你的确认`,
    suggestion: { kind: 'allow-tool', toolName: def.name },
  }
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)]
}

function describePaths(paths: readonly string[]): string {
  const visible = paths.slice(0, 5)
  const suffix = paths.length > visible.length
    ? `（另有 ${paths.length - visible.length} 项，详见调用参数）`
    : ''
  return `${visible.join('、')}${suffix}`
}
