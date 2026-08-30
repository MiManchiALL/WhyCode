import {
  asSchema,
  type FlexibleSchema,
  type InferSchema,
} from 'ai'
import type { ImageAttachment, ImageTransform } from '../attachments/types.ts'
import type { PdfAttachment } from '../pdf/types.ts'
import type { ToolFileChange } from './file-changes.ts'

/**
 * WhyCode 工具接口。内置工具继续用 Zod；运行时工具可直接使用带验证器的 JSON Schema。
 * fail-closed：未声明的行为标记按最保守处理（buildTool 中填充默认值）。
 */
export interface ToolDefinition<
  InputSchema extends FlexibleSchema = FlexibleSchema<any>,
> {
  /** 工具名（PascalCase），必须从工具目录的常量导出引用 */
  name: string
  /** 给 UI 的一句话描述 */
  description: string
  /** 给模型的完整说明（与实现同目录的 prompt.ts） */
  prompt: string
  inputSchema: InputSchema
  /** 只读工具可与其它只读工具并行执行 */
  isReadOnly: boolean
  /** 权限类别：read 读取；control 只限内部/保护性控制；edit/execute 受相应档位约束。 */
  kind: 'read' | 'edit' | 'execute' | 'control'
  /** 该工具建立计划身份或执行权边界，必须独占一次模型 step。 */
  requiresStandaloneStep: boolean
  /** 成功执行后立即结束当前 turn，不再发起下一次模型调用。 */
  endsTurnOnSuccess: boolean
  /** 隐私或信任边界首次使用也需审批；会话记住或全自动档仍服从常规硬拒绝。 */
  initialApprovalReason?: string
  /** 终止型工具成功后的语义；waiting-user 会保留计划并等待下一条用户消息。 */
  turnEndReasonOnSuccess: 'completed' | 'waiting-user'
  /** 本次调用涉及的路径（原始输入值），权限引擎据此做边界与敏感检查 */
  extractPaths?: (input: InferSchema<InputSchema>) => string[]
  /**
   * 回滚覆盖契约。它与权限路径分开：权限回答“能否执行”，这里回答“能否完整撤销”。
   * 未声明的写工具按不可回滚处理，避免 UI 给出虚假的成功承诺。
   */
  checkpointScope?: (
    input: InferSchema<InputSchema>,
    ctx: ToolContext,
  ) => ToolCheckpointScope | Promise<ToolCheckpointScope>
  /** 写文件类工具生成变更预览（unified diff），用于审批 UI */
  renderDiff?: (input: InferSchema<InputSchema>, ctx: ToolContext) => Promise<string | undefined>
  execute: (input: InferSchema<InputSchema>, ctx: ToolContext) => Promise<ToolResult>
}

export type ToolCheckpointScope = { kind: 'exact-files'; paths: string[] }

export interface ToolContext {
  /** 项目根目录（所有相对路径的基准） */
  projectDir: string
  /** 本会话固定 scratch 与额外授权目录（与权限上下文同步） */
  additionalDirs: readonly string[]
  abortSignal: AbortSignal
  /** 当前工具步骤确实接合的计划；后台任务终态只可据此恢复同一计划。 */
  engagedPlanId?: string
  /** 当前父回合与工具调用的稳定身份；异步宿主任务用它建立可追溯所有权。 */
  turnId?: string
  toolCallId?: string
  /** 长时工具的增量输出回调（终端输出等） */
  onProgress?: (output: string) => void
}

export interface ToolResult {
  /** 回传给模型的内容 */
  data: string
  isError: boolean
  /** 工具新导入的会话图片；由 AgentSession 在稳定 step 中注入并持久化。 */
  attachments?: readonly ImageAttachment[]
  /** 工具新导入的会话 PDF；由 AgentSession 与当前稳定 step 一起登记。 */
  pdfAttachments?: readonly PdfAttachment[]
  /** 模型读取这些附件时使用的像素策略；不影响持久化原图。 */
  imageTransform?: ImageTransform
  /** 文件编辑工具实际落盘后的逐文件增删行统计。 */
  fileChanges?: readonly ToolFileChange[]
}

const CONSERVATIVE_DEFAULTS = {
  isReadOnly: false,
  kind: 'execute' as const,
  requiresStandaloneStep: false,
  endsTurnOnSuccess: false,
  turnEndReasonOnSuccess: 'completed' as const,
}

/** 集中填充 fail-closed 默认值 */
export function buildTool<InputSchema extends FlexibleSchema>(
  def: Omit<ToolDefinition<InputSchema>, keyof typeof CONSERVATIVE_DEFAULTS> &
    Partial<Pick<ToolDefinition<InputSchema>, keyof typeof CONSERVATIVE_DEFAULTS>>,
): ToolDefinition<InputSchema> {
  return { ...CONSERVATIVE_DEFAULTS, ...def }
}

/** 所有工具参数共用这一条验证边界；没有运行时验证器的 schema 一律拒绝。 */
export async function validateToolInput<InputSchema extends FlexibleSchema>(
  def: ToolDefinition<InputSchema>,
  input: unknown,
): Promise<
  | { success: true; value: InferSchema<InputSchema> }
  | { success: false; error: Error }
> {
  const schema = asSchema(def.inputSchema)
  if (!schema.validate) {
    return {
      success: false,
      error: new Error(`${def.name} 的参数 schema 没有运行时验证器`),
    }
  }
  return schema.validate(input)
}
