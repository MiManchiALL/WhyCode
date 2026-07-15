import type { z } from 'zod'
import type { ImageAttachment, ImageTransform } from '../attachments/types.ts'

/**
 * WhyCode 工具接口。Zod schema 为单一事实源：类型推导 + 运行时校验 + JSON Schema 派生。
 * fail-closed：未声明的行为标记按最保守处理（buildTool 中填充默认值）。
 */
export interface ToolDefinition<Schema extends z.ZodObject = z.ZodObject> {
  /** 工具名（PascalCase），必须从工具目录的常量导出引用 */
  name: string
  /** 给 UI 的一句话描述 */
  description: string
  /** 给模型的完整说明（与实现同目录的 prompt.ts） */
  prompt: string
  inputSchema: Schema
  /** 只读工具可与其它只读工具并行执行 */
  isReadOnly: boolean
  /** 权限档位判定用的操作类别：read 免审批 / edit 受 acceptEdits 档控制 / execute 最严 */
  kind: 'read' | 'edit' | 'execute' | 'control'
  /** 控制面工具可在无项目的讨论会话中使用；默认 false，避免意外暴露文件/命令工具。 */
  availableWithoutProject: boolean
  /** 该工具建立计划身份或执行权边界，必须独占一次模型 step。 */
  requiresStandaloneStep: boolean
  /** 成功执行后立即结束当前 turn，不再发起下一次模型调用。 */
  endsTurnOnSuccess: boolean
  /** 隐私敏感读操作首次使用也需审批；会话记住后才按普通权限链放行。 */
  initialApprovalReason?: string
  /** 终止型工具成功后的语义；waiting-user 会保留计划并等待下一条用户消息。 */
  turnEndReasonOnSuccess: 'completed' | 'waiting-user'
  /** 本次调用涉及的路径（原始输入值），权限引擎据此做边界与敏感检查 */
  extractPaths?: (input: z.infer<Schema>) => string[]
  /**
   * 回滚覆盖契约。它与权限路径分开：权限回答“能否执行”，这里回答“能否完整撤销”。
   * 未声明的写工具按不可回滚处理，避免 UI 给出虚假的成功承诺。
   */
  checkpointScope?: (
    input: z.infer<Schema>,
    ctx: ToolContext,
  ) => ToolCheckpointScope | Promise<ToolCheckpointScope>
  /** 写文件类工具生成变更预览（unified diff），用于审批 UI */
  renderDiff?: (input: z.infer<Schema>, ctx: ToolContext) => Promise<string | undefined>
  execute: (input: z.infer<Schema>, ctx: ToolContext) => Promise<ToolResult>
}

export type ToolCheckpointScope = { kind: 'exact-files'; paths: string[] }

export interface ToolContext {
  /** 项目根目录（所有相对路径的基准） */
  projectDir: string
  /** 本会话内额外授权的目录（与权限上下文同步） */
  additionalDirs: readonly string[]
  abortSignal: AbortSignal
  /** 长时工具的增量输出回调（终端输出等） */
  onProgress?: (output: string) => void
}

export interface ToolResult {
  /** 回传给模型的内容 */
  data: string
  isError: boolean
  /** 工具新导入的会话图片；由 AgentSession 在稳定 step 中注入并持久化。 */
  attachments?: readonly ImageAttachment[]
  /** 模型读取这些附件时使用的像素策略；不影响持久化原图。 */
  imageTransform?: ImageTransform
}

const CONSERVATIVE_DEFAULTS = {
  isReadOnly: false,
  kind: 'execute' as const,
  availableWithoutProject: false,
  requiresStandaloneStep: false,
  endsTurnOnSuccess: false,
  turnEndReasonOnSuccess: 'completed' as const,
}

/** 集中填充 fail-closed 默认值 */
export function buildTool<Schema extends z.ZodObject>(
  def: Omit<ToolDefinition<Schema>, keyof typeof CONSERVATIVE_DEFAULTS> &
    Partial<Pick<ToolDefinition<Schema>, keyof typeof CONSERVATIVE_DEFAULTS>>,
): ToolDefinition<Schema> {
  return { ...CONSERVATIVE_DEFAULTS, ...def }
}
