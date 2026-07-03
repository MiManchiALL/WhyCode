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
  /** 是否需要用户审批（M1：所有写类工具恒为 true） */
  needsApproval: (input: z.infer<Schema>) => boolean
  /** 写文件类工具生成变更预览（unified diff），用于审批 UI */
  renderDiff?: (input: z.infer<Schema>) => Promise<string | undefined>
  execute: (input: z.infer<Schema>, ctx: ToolContext) => Promise<ToolResult>
}

export interface ToolContext {
  /** 项目根目录（所有相对路径的基准） */
  projectDir: string
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
  needsApproval: () => true,
} as const

/** 集中填充 fail-closed 默认值 */
export function buildTool<Schema extends z.ZodObject>(
  def: Omit<ToolDefinition<Schema>, keyof typeof CONSERVATIVE_DEFAULTS> &
    Partial<Pick<ToolDefinition<Schema>, keyof typeof CONSERVATIVE_DEFAULTS>>,
): ToolDefinition<Schema> {
  return { ...CONSERVATIVE_DEFAULTS, ...def }
}
