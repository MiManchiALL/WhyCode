import type { z } from 'zod'

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
  kind: 'read' | 'edit' | 'execute'
  /** 控制面工具可在无项目的讨论会话中使用；默认 false，避免意外暴露文件/命令工具。 */
  availableWithoutProject: boolean
  /** 成功执行后立即结束当前 turn，不再发起下一次模型调用。 */
  endsTurnOnSuccess: boolean
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

export type ToolCheckpointScope =
  | { kind: 'exact-files'; paths: string[] }
  | { kind: 'workspace-roots'; roots: string[]; warning: string }

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
}

const CONSERVATIVE_DEFAULTS = {
  isReadOnly: false,
  kind: 'execute' as const,
  availableWithoutProject: false,
  endsTurnOnSuccess: false,
}

/** 集中填充 fail-closed 默认值 */
export function buildTool<Schema extends z.ZodObject>(
  def: Omit<ToolDefinition<Schema>, keyof typeof CONSERVATIVE_DEFAULTS> &
    Partial<Pick<ToolDefinition<Schema>, keyof typeof CONSERVATIVE_DEFAULTS>>,
): ToolDefinition<Schema> {
  return { ...CONSERVATIVE_DEFAULTS, ...def }
}
