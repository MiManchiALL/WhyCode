import { localWorkspaceIO, type WorkspaceIO } from '../workspace/io.ts'
import { stepCountIs, streamText, tool as aiTool, type ModelMessage } from 'ai'
import { randomUUID } from 'node:crypto'
import { modelMessageText } from '../text.ts'
import type {
  ContextUsageInfo,
  CoreEvent,
  QueuedUserMessage,
  StopReason,
  UsageInfo,
  UserQuestion,
} from '../events.ts'
import type { ModelEntry, ProviderConfig } from '../providers/registry.ts'
import type { ReasoningEffortSelection } from '../providers/catalog.ts'
import { providerOptionsWithReasoningEffort } from '../providers/reasoning-effort.ts'
import {
  validateToolInput,
  type ToolContext,
  type ToolDefinition,
} from '../tools/tool.ts'
import { BUILTIN_TOOLS } from '../tools/registry.ts'
import type { ToolFileChange } from '../tools/file-changes.ts'
import { buildSystemPrompt, type PromptContext } from '../prompts/system.ts'
import { BTW_TOOL_NAMES, createBtwUserMessages } from '../prompts/btw.ts'
import type { CustomSystemPromptSnapshot } from '../prompts/custom-system.ts'
import { currentDateReminder } from '../prompts/current-date.ts'
import { checkToolPermission } from '../permissions/engine.ts'
import {
  CheckpointManager,
  type TurnEditEffects,
  type RestoreCheckpointResult,
} from '../checkpoints/manager.ts'
import {
  autoCompactThreshold,
  estimateContextTokens,
  estimateMessagesTokens,
  estimateRequestContextOverhead,
  type TokenBaseline,
} from '../context/tokens.ts'
import { microcompact } from '../context/microcompact.ts'
import { compactMessages } from '../context/compact.ts'
import type { SessionRecorder } from '../session/types.ts'
import {
  applyProjectInstructions,
  findProjectInstructionsMessage,
  loadProjectInstructions,
  projectInstructionsUpdate,
  type ProjectInstructionsUpdate,
} from '../instructions/project.ts'
import {
  createTurnAbortedConsumedMessage,
  createTurnAbortedMessage,
  findPendingTurnAbortedIndex,
  type TurnInterruptionContext,
} from '../session/interruption.ts'
import {
  createImageUserMessage,
  dehydrateImageMessages,
  messagesForModel,
  referencedImageAttachmentIds,
} from '../attachments/messages.ts'
import {
  TOOL_IMAGE_ATTACHMENT_MAX_COUNT,
  imageAttachmentSchema,
  type ImageAttachment,
  type ImageDeliveryMode,
  type ImageTransform,
} from '../attachments/types.ts'
import { READ_FILE_TOOL_NAME } from '../tools/read-file/index.ts'
import { createViewImageTool } from '../tools/view-image/index.ts'
import { createAnalyzeImageTool } from '../tools/analyze-image/index.ts'
import type { AuxiliaryImageAnalyzer } from '../auxiliary/image-analysis.ts'
import {
  createCaptureScreenshotTool,
  type ScreenshotCaptureHandler,
} from '../tools/capture-screenshot/index.ts'
import { createAskUserQuestionTool } from '../tools/ask-user-question/index.ts'
import { resolveAllowed } from '../tools/fs-utils.ts'
import {
  compactPdfAttachmentContext,
  referencedPdfAttachmentIds,
  withPdfAttachmentReferences,
} from '../pdf/messages.ts'
import { pdfAttachmentPath } from '../pdf/storage.ts'
import {
  PDF_VISUAL_MAX_PAGES,
  pdfAttachmentSchema,
  type PdfAttachment,
} from '../pdf/types.ts'
import type { PdfProcessor } from '../pdf/processor.ts'
import { inlineSmallPdfMessages } from '../pdf/inline-messages.ts'
import {
  adaptMessagesForProvider,
  normalizeResponseMessagesForProvider,
} from '../providers/message-adapter.ts'
import { createReadPdfTool, READ_PDF_TOOL_NAME } from '../tools/read-pdf/index.ts'
import type { OfficeProcessor } from '../office/types.ts'
import { createRenderOfficeTool } from '../tools/render-office/index.ts'
import { TaskPlanController } from '../tasks/controller.ts'
import { LoopHealthMonitor } from '../tasks/loop-health.ts'
import { emptyModelResponse, readModelStream, withModelRequestRetry } from '../providers/model-request.ts'
import {
  createTaskPlanTools,
  type TaskPlanEngagementAction,
  UPDATE_TASK_ITEM_TOOL_NAME,
} from '../tasks/tools.ts'
import type { TaskPlanState } from '../tasks/types.ts'
import { taskPlanViewBeforeTurn } from '../session/task-plan-view.ts'
import {
  createTaskContextMessage,
  createTaskExecutionBoundaryMessage,
  createTaskStateMessage,
  taskContextBlock,
} from '../tasks/context.ts'
import {
  createUserQuestionMarker,
  findPendingUserQuestion,
  isUserQuestionAnswer,
} from '../tasks/answer-resume.ts'
import {
  createPermissionContext,
  type ApprovalSuggestion,
  type PermissionContext,
  type PermissionMode,
} from '../permissions/types.ts'
import type { McpSessionRuntime, McpStepBinding } from '../mcp/runtime.ts'
import type { McpManagerSnapshot } from '../mcp/manager.ts'
import { carryMcpToolState, withoutMcpToolState } from '../mcp/state.ts'
import { inspectLatestTurnEdit, latestTurnEditContext } from './turn-edit.ts'
import {
  activatedSkillSchema,
  skillSummary,
  type ActivatedSkill,
  type SkillSummary,
} from '../skills/types.ts'
import type { SkillCatalogService } from '../skills/catalog.ts'
import { SkillTurnContext } from '../skills/turn.ts'
import { createSkillTool, SKILL_TOOL_NAME } from '../tools/skill/index.ts'
import { createCommandTaskNotificationMessage } from '../tools/background-command/notification.ts'
import type { CommandTaskTerminalNotification } from '../tools/background-command/types.ts'
import type { SubagentDefinitionCatalogService } from '../subagents/catalog.ts'
import { createSubagentSettlementMessage } from '../subagents/notification.ts'
import {
  createSubagentTurnStateMessage,
  hasOutstandingSubagentActivations,
} from '../subagents/turn-context.ts'
import type {
  SubagentPermissionSnapshot,
  SubagentSettlementNotification,
  SubagentTurnState,
} from '../subagents/types.ts'
import { subagentTurnStateSchema } from '../subagents/types.ts'
import { AssistantTextGate, sanitizeAssistantControlOutput } from './assistant-output.ts'
import { ToolExecutionBatch, toolsForModel, type StepToolSet, type ToolEndEvent } from './tool-execution.ts'
import { ToolStepAttachments } from './tool-step-attachments.ts'
import { appendOrderedMessages, TOOL_NOT_STARTED } from '../session/tool-execution.ts'
import {
  StepToolApprovalBatcher,
  type ApprovalHandler,
} from './tool-approval.ts'
import type {
  BtwTurnContext,
  BtwTurnResult,
  BtwToolStep,
} from '../session/btw.ts'

export type {
  ApprovalHandler,
  ApprovalRequest,
  ApprovalRequestItem,
  ApprovalResponse,
} from './tool-approval.ts'

const BOUNDED_MAX_STEPS = 40
const FINALIZATION_RESERVE_STEPS = 5
const TASK_PROGRESS_REMINDER_STEPS = 10
const MAX_COMPACT_FAILURES = 3

interface ToolStepContext {
  emit: (event: CoreEvent) => void
  loopHealth: LoopHealthMonitor
  onToolExecutionStart?: (toolCallId: string) => Promise<void>
  onToolExecutionEnd?: (event: ToolEndEvent) => Promise<string>
  allowedToolNames?: ReadonlySet<string>
  planExecutionEngaged?: boolean
  onTaskPlanEngagement?: (action: TaskPlanEngagementAction) => void
  onUserQuestion?: (question: UserQuestion) => void
  onTurnEndingTool?: (reason: 'completed' | 'waiting-user') => void
  onReadFile?: (path: string) => void
  onImageAttachments?: (
    toolCallId: string, attachments: readonly ImageAttachment[],
    transform: ImageTransform | undefined, attachmentLimit: number,
  ) => Promise<string | null>
  onPdfAttachments?: (
    toolCallId: string, attachments: readonly PdfAttachment[],
  ) => Promise<string | null>
}

export interface AgentSessionOptions {
  workspaceIO?: WorkspaceIO
  model: ModelEntry
  providerConfig: ProviderConfig
  reasoningEffort?: ReasoningEffortSelection
  promptContext: PromptContext
  /** Main 会话创建时固化的用户 System；B/C 不传入，避免越过独立 Agent 边界。 */
  customSystemPrompt?: CustomSystemPromptSnapshot
  /** 额外注入的工具（M3：SubmitProtocolOutput 等协商工具） */
  extraTools?: ToolDefinition[]
  /** 角色能力白名单；省略时使用完整内置文件工具集。 */
  baseTools?: readonly ToolDefinition[]
  /** 宿主为普通 Main 注入的会话工具；讨论/协议回合物理移除（如后台命令）。 */
  mainTools?: ToolDefinition[]
  /** Electron 等宿主注入的桌面采集能力；Core 不依赖具体窗口系统。 */
  captureScreenshot?: ScreenshotCaptureHandler
  /** 宿主注入的隔离 PDF 处理端口；未提供时物理移除 ReadPdf。 */
  pdfProcessor?: PdfProcessor
  /** Office 结构检查与后台渲染端口；视觉渲染只对图片模型开放。 */
  officeProcessor?: OfficeProcessor
  /** 非视觉 Main 可按需调用的独立识图模型；视觉 Main 不装配对应工具。 */
  auxiliaryImageAnalyzer?: AuxiliaryImageAnalyzer
  /** 宿主判断当前计划是否仍有已登记、将自动唤醒同一会话的后台任务。 */
  hasPendingTaskPlanContinuation?: (planId: string) => boolean
  /** 宿主从持久事实源投影当前父 turn 的子代理激活状态。 */
  getSubagentTurnState?: (turnId: string) => Promise<SubagentTurnState>
  /** M4：稳定边界会话记录器；不传则保持纯内存会话 */
  sessionRecorder?: SessionRecorder
  /** Main 会话级 MCP 运行时；讨论/协议回合仍由工具装配边界物理移除。 */
  mcpRuntime?: McpSessionRuntime
  /** 普通 Main 的 Skill 磁盘事实源；讨论/协议回合即使复用 Session 也不会装配。 */
  skillCatalog?: SkillCatalogService
  /** 普通 Main 每个根任务重新扫描的子代理定义目录；子代理自身不传入。 */
  subagentCatalog?: SubagentDefinitionCatalogService
  /** 子代理冷恢复时继承的父权限与已批准规则；角色工具白名单仍可继续收窄。 */
  initialPermission?: SubagentPermissionSnapshot
  /** 默认开启；子代理和协议运行体在构造时物理关闭。 */
  userQuestionsEnabled?: boolean
  /**
   * 宿主级项目副作用调度边界。单个 Agent 内由工具批次屏障保序；桌面宿主
   * 可在此进一步串行同一项目中来自不同会话的 edit/execute 与检查点回滚。
   */
  scheduleProjectMutation?: <T>(
    mutation:
      | { type: 'tool'; name: string; kind: 'edit' | 'execute' }
      | { type: 'checkpoint-restore'; toolUseId: string }
      | { type: 'turn-edit'; turnId: string },
    abortSignal: AbortSignal,
    operation: () => Promise<T>,
  ) => Promise<T>
  /** 事件出口（宿主注入） */
  emit: (event: CoreEvent) => void
  /** 审批回调（宿主注入）：返回用户的决定 */
  requestApproval: ApprovalHandler
}

/**
 * 编辑事务已经持久化后的单次交付句柄。宿主可按当前模式选择直接交给 Main，
 * 或先 accept 后交给协商协调器；两条路径共享同一个新根输入身份。
 */
export interface PreparedLatestTurnEdit {
  readonly inputId: string
  readonly text: string
  readonly attachments: readonly ImageAttachment[]
  readonly imageDelivery: ImageDeliveryMode
  readonly pdfAttachments: readonly PdfAttachment[]
  readonly skills: readonly ActivatedSkill[]
  accept(): void
  startMain(): Promise<StopReason>
}

export interface BtwTurnLifecycle {
  /** BTW 可见事件不走 Main 的 ViewTimeline；宿主由独立事实统一恢复。 */
  emit: (event: CoreEvent) => void
  onSettled: (result: BtwTurnResult, continuesWithMainWork: boolean) => Promise<void>
}

interface QueuedMessage {
  id: string
  text: string
  attachments: ImageAttachment[]
  imageDelivery: ImageDeliveryMode
  pdfAttachments: PdfAttachment[]
  skills: ActivatedSkill[]
  /** Desktop 预写了 user-input 时，送达/恢复必须携带同一稳定 ID。 */
  persisted: boolean
}

type ContinuationNotification = CommandTaskTerminalNotification | SubagentSettlementNotification

interface QueuedTaskNotification {
  notification: ContinuationNotification
  message: ModelMessage
  /** 父 transcript 已稳定记录通知后确认交接；崩溃重放据此保持至少一次。 */
  onDelivered?: () => void | Promise<void>
}

interface TurnModelSelection {
  model: ModelEntry
  providerConfig: ProviderConfig
  reasoningEffort: ReasoningEffortSelection
}

function queuedMessageForModel(message: QueuedMessage): ModelMessage {
  const text = withPdfAttachmentReferences(message.text, message.pdfAttachments)
  return message.attachments.length
    ? createImageUserMessage(text, message.attachments, message.imageDelivery)
    : { role: 'user', content: text }
}

function queuedUserMessage(message: QueuedMessage): QueuedUserMessage {
  return {
    id: message.id,
    text: message.text,
    ...(message.attachments.length ? { attachments: message.attachments } : {}),
    ...(message.pdfAttachments.length ? { pdfAttachments: message.pdfAttachments } : {}),
    ...(message.skills.length ? { skills: message.skills.map(skillSummary) } : {}),
  }
}

interface StepResult {
  committed: boolean
  hadToolCalls: boolean
  /** 仅保存既有计划进度，不代表模型决定忽略最新 steering 继续实质执行。 */
  hadOnlyTaskProgressUpdates: boolean
  toolEndReason: 'completed' | 'waiting-user' | null
  taskPlanChanged: boolean
  taskPlanEngagement: TaskPlanEngagementAction | null
  interruptionBoundaryConsumed: boolean
  awaitingTaskPlanContinuation: boolean
}

/**
 * Agent 会话（M2-a：自持外层循环 + steering 消息队列）。
 *
 * 循环架构（对齐文档二 §5.1 / 文档一 §3.1）：外层循环每次 streamText 只跑一步
 * （stepCountIs(1)，工具仍由 AI SDK 在步内执行），消息数组由本类维护——
 * 步骤间因此可以注入排队的用户消息（steering）、后续可做压缩改写（M2-d）。
 */
export class AgentSession {
  private messages: ModelMessage[] = []
  private queue: QueuedMessage[] = []
  private taskNotifications: QueuedTaskNotification[] = []
  private running = false
  /** 当前步骤的中止器：turn 级取消与 urgent 插话都经由它，用 reason 区分意图 */
  private currentStepAbort: AbortController | null = null
  private options: AgentSessionOptions
  /** 当前 turn 固化的模型配置；运行中切换只影响下一 turn。 */
  private activeModelSelection: TurnModelSelection | null = null
  /** 权限上下文（mode / 额外授权目录 / 会话内记住的工具） */
  private permissions: PermissionContext
  private checkpoints: CheckpointManager | null = null
  private checkpointDisabledNotified = false
  /** 回滚是文件与会话的补偿事务；同一会话同一时刻只允许一个事务运行。 */
  private restoringCheckpointToolUseId: string | null = null
  private editingTurn = false
  private readonly idleWaiters = new Set<() => void>()
  /** waiting-subagents 期间的单次事件唤醒；不轮询，也不启动额外 turn。 */
  private runLoopWake: (() => void) | null = null
  /** 根 turn 持有检查点归属与净变化摘要，结束后一起释放。 */
  private activeTurn: { id: string; fileChanges: Map<string, ToolFileChange> } | null = null
  /** 当前操作（turn 或压缩）的中止器，session 自管 */
  private opAbort: AbortController | null = null
  /** 稳定 step 已结束后的持久化窗口不回滚结果，但停止请求会阻止队列自动接续。 */
  private abortRequestedDuringFinalization = false
  private turnInterruptionContext: TurnInterruptionContext | null = null
  /** 手动压缩进行中（此间用户消息排队，压缩后接续） */
  private compacting = false
  /** token 计量基线（最后一次 API usage）；改写历史后置 null 全量重估 */
  private tokenBaseline: TokenBaseline | null = null
  /** API usage 所含 Skill 请求投影相对长期消息的差值。 */
  private tokenBaselineSkillProjectionDelta = 0
  /** API usage 所含当前 turn 子代理状态投影相对长期消息的差值。 */
  private tokenBaselineSubagentProjectionDelta = 0
  /** 仅在当前 turn 内存在，用于请求投影和上下文估算；从不写入 transcript。 */
  private activeSubagentTurnState: SubagentTurnState | null = null
  /** 父 transcript 已提交的终态；manifest 的 delivered 回写失败也不能让 turn 永久等待。 */
  private deliveredSubagentActivations = new Set<string>()
  /** 最近一次真实请求（或空闲态重建）的 System / 工具目录估算。 */
  private contextOverhead: Pick<
    ContextUsageInfo['breakdown'],
    'systemPromptTokens' | 'toolTokens'
  > | null = null
  /** 压缩熔断：连续失败 3 次后本会话停止尝试，成功清零 */
  private compactFailures = 0
  /** 会话内读过的文件（压缩后重注入用）：绝对路径 → 最后读取时间 */
  private recentReadFiles = new Map<string, number>()
  /** 用户输入与图片工具导入的权威附件元数据；长期消息只保存其稳定引用。 */
  private imageAttachments = new Map<string, ImageAttachment>()
  /** 用户上传 PDF 的权威元数据；ReadPdf 只通过此表解析不透明 ID。 */
  private pdfAttachments = new Map<string, PdfAttachment>()
  /** 当前模型活动历史或待处理输入仍引用的 PDF；回滚后不得重新注入已离开分支的附件。 */
  private activePdfAttachmentIds = new Set<string>()
  /** 持久化失败后本会话降级内存模式，避免每个 step 重复报错 */
  private persistenceFailed = false
  /** 正式协议回合只通过结构化事件展示结果，避免内部候选文本混入最终回答。 */
  private protocolRound = false
  /** 仅 Main 正常执行拥有任务控制；B/C 创建时已经处于 discussion，因此不会获得。 */
  private taskPlan: TaskPlanController | null = null
  private loopHealth = new LoopHealthMonitor()
  private readonly skillTurn: SkillTurnContext
  /** 协商事务期间由 Orchestrator 关闭，避免协议内或执行包中途向用户提问。 */
  private userQuestionsEnabled: boolean
  /** 最近一个稳定模型步骤的结束原因，供一次性子代理激活映射可靠终态。 */
  private lastFinishReason: string | null = null
  /** 当前 turn 最近一个已提交的 assistant 正文；新 turn 清空，不能回落到历史回复。 */
  private lastTurnAssistantText = ''
  /** 完整共识任务期间由 Coordinator 持有最终 idle，避免 Main 与任务终点之间出现假空闲。 */
  private terminalStatusManaged = false
  /** 独立模型会话的传输身份；恢复沿用会话 ID，内存代理按实例分配。 */
  private readonly transportSessionId: string
  constructor(options: AgentSessionOptions) {
    this.options = options
    this.transportSessionId = options.sessionRecorder?.sessionId ?? randomUUID()
    this.userQuestionsEnabled = options.userQuestionsEnabled ?? true
    this.skillTurn = new SkillTurnContext(options.skillCatalog, (skills) => {
      this.options.emit({ type: 'active-skills-changed', skills })
    })
    const initialMessages = options.sessionRecorder?.initialMessages ?? []
    this.messages = applyProjectInstructions(
      initialMessages,
      findProjectInstructionsMessage(initialMessages),
    )
    this.addImageAttachments(options.sessionRecorder?.initialImageAttachments ?? [])
    this.addPdfAttachments(options.sessionRecorder?.initialPdfAttachments ?? [])
    this.queue = (options.sessionRecorder?.pendingUserInputs ?? [])
      .filter((input) => input.state === 'queued')
      .map((input) => ({
        id: input.id,
        text: input.text,
        attachments: [...(input.attachments ?? [])],
        imageDelivery: input.attachments?.length ? input.imageDelivery! : 'native',
        pdfAttachments: [...(input.pdfAttachments ?? [])],
        skills: [...(input.skills ?? [])].map((skill) => structuredClone(skill)),
        persisted: true,
      }))
    this.rebuildActivePdfAttachments()
    this.permissions = createPermissionContext(
      options.promptContext.projectDir,
      options.promptContext.discussion,
      options.promptContext.scratch?.rootDir,
    )
    this.permissions.workspaceIO = options.workspaceIO
    if (options.initialPermission) {
      this.permissions.mode = options.initialPermission.mode
      this.permissions.additionalDirs = [...new Set([
        ...this.permissions.additionalDirs,
        ...options.initialPermission.additionalDirs.map((path) => (options.workspaceIO ?? localWorkspaceIO).path.resolve(path)),
      ])]
      this.permissions.sessionAllowedTools = [...new Set(
        options.initialPermission.sessionAllowedTools,
      )]
    }
    if (!options.promptContext.discussion) {
      this.taskPlan = new TaskPlanController(
        options.sessionRecorder?.initialTaskState,
      )
    }
    // 讨论阶段的会话不做检查点（不写项目，无需快照）
    if (options.sessionRecorder && !options.promptContext.discussion) {
      this.checkpoints = new CheckpointManager({
        sessionDir: options.sessionRecorder.checkpointDirectory,
        sessionId: options.sessionRecorder.sessionId,
        workspaceIO: options.workspaceIO,
      })
    }
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissions.mode = mode
  }

  get permissionMode(): PermissionMode {
    return this.permissions.mode
  }

  get permissionSnapshot(): SubagentPermissionSnapshot {
    return {
      mode: this.permissions.mode,
      additionalDirs: [...this.permissions.additionalDirs],
      sessionAllowedTools: [...this.permissions.sessionAllowedTools],
    }
  }

  get modelFinishReason(): string | null {
    return this.lastFinishReason
  }

  get latestTurnAssistantText(): string {
    return this.lastTurnAssistantText
  }

  private updateLastTurnAssistantText(messages: readonly ModelMessage[]): void {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!
      if (message.role !== 'assistant') continue
      const text = modelMessageText(message).trim()
      if (text) {
        this.lastTurnAssistantText = text
        return
      }
    }
  }

  async setModelSelection(
    model: ModelEntry,
    providerConfig: ProviderConfig,
    reasoningEffort: ReasoningEffortSelection,
  ): Promise<void> {
    const modelChanged = this.options.model.id !== model.id
    if (
      modelChanged
      || this.options.reasoningEffort !== reasoningEffort
    ) {
      await this.persist((recorder) =>
        recorder.updateModelSelection(model.id, reasoningEffort),
      )
    }
    this.options = { ...this.options, model, providerConfig, reasoningEffort }
    if (modelChanged) {
      this.tokenBaseline = null
      this.contextOverhead = null
      this.options.emit({ type: 'context-usage', usage: null })
    }
    if (!this.activeModelSelection && (modelChanged || !this.contextOverhead)) {
      await this.initializeContextUsage()
    }
  }

  /** Main 初始化/模型切换时建立可展示估算；计量失败不应影响会话可用性。 */
  async initializeContextUsage(): Promise<void> {
    try {
      // 空闲态也按“下一次普通请求”投影 Skill 目录与 Skill 工具；Fork/恢复不能只算持久消息。
      await this.prepareSkillTurn([])
      const abortSignal = new AbortController().signal
      const systemPrompt = buildSystemPrompt(
        this.options.promptContext,
        this.options.customSystemPrompt,
      )
      const tools = this.buildToolSet(
        abortSignal,
        { emit: this.options.emit, loopHealth: this.loopHealth },
        [],
      )
      const overhead = await estimateRequestContextOverhead(
        systemPrompt,
        toolsForModel(tools),
      )
      this.contextOverhead = overhead
      this.emitContextUsage()
    } catch {
      this.contextOverhead = null
      this.options.emit({ type: 'context-usage', usage: null })
    }
  }

  setAuxiliaryImageAnalyzer(analyzer: AuxiliaryImageAnalyzer | undefined): void {
    if (this.isBusy) throw new Error('Agent 工作中，不能切换辅助识图模型')
    this.options = { ...this.options, auxiliaryImageAnalyzer: analyzer }
  }

  private createLanguageModel() {
    const selection = this.currentModelSelection()
    return selection.model.create(selection.providerConfig, {
      transportSessionId: this.transportSessionId,
    })
  }

  private requestProviderOptions() {
    const selection = this.currentModelSelection()
    return providerOptionsWithReasoningEffort(
      selection.model,
      selection.reasoningEffort,
    )
  }

  private currentModelSelection(): TurnModelSelection {
    return this.activeModelSelection ?? {
      model: this.options.model,
      providerConfig: this.options.providerConfig,
      reasoningEffort: this.options.reasoningEffort ?? 'default',
    }
  }

  /** 替换注入的额外工具（M3：每轮协商换入该轮的协议输出工具） */
  setExtraTools(tools: ToolDefinition[]): void {
    this.options = { ...this.options, extraTools: tools }
  }

  setProtocolRound(active: boolean): void {
    this.protocolRound = active
  }

  setUserQuestionsEnabled(enabled: boolean): void {
    this.userQuestionsEnabled = enabled
  }

  setTerminalStatusManaged(managed: boolean): void {
    this.terminalStatusManaged = managed
  }

  /**
   * 切换讨论档（M3）：进入协商讨论阶段时禁写项目、写实验限 scratch；null = 恢复正常执行档。
   * scratch 目录保留在 additionalDirs 中，执行阶段 Main 仍可读取实验产物。
   */
  setDiscussion(discussion: { agentId: 'Main' | 'B' | 'C'; scratchDir: string } | null): void {
    this.options = {
      ...this.options,
      promptContext: { ...this.options.promptContext, discussion: discussion ?? undefined },
    }
    this.permissions.discussion = discussion ? { scratchDir: discussion.scratchDir } : undefined
    if (discussion && !this.permissions.additionalDirs.includes(discussion.scratchDir)) {
      this.permissions.additionalDirs.push(discussion.scratchDir)
    }
  }

  get isRunning(): boolean {
    return this.running
  }

  get isBusy(): boolean {
    return this.running || this.compacting || this.restoringCheckpointToolUseId !== null || this.editingTurn
  }

  /** 空闲但仍在等待 AskUserQuestion 的真实回答；宿主应让用户输入先进入路由。 */
  get waitingForUserInput(): boolean {
    return !this.isBusy && findPendingUserQuestion(this.messages) !== null
  }

  get checkpointRestoreToolUseId(): string | null {
    return this.restoringCheckpointToolUseId
  }

  get turnFileChanges(): ToolFileChange[] {
    return [...(this.activeTurn?.fileChanges.values() ?? [])]
  }

  get activeSkills(): SkillSummary[] {
    return this.skillTurn.activeSkills
  }

  get mcpSnapshot(): McpManagerSnapshot | null {
    return this.options.mcpRuntime?.connectionManager().snapshot(true) ?? null
  }

  waitUntilIdle(): Promise<void> {
    if (!this.isBusy) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  async dispose(): Promise<void> {
    await this.options.mcpRuntime?.close()
  }

  /** 协商事务锚点：返回隔离副本，失败/取消时由 Orchestrator 恢复。 */
  captureMessageSnapshot(): ModelMessage[] {
    return structuredClone(this.messages)
  }

  /**
   * 独立侧对话只共享背景与权限，工具步骤和回答不写入 Main messages。
   * 已提交输入即成为侧链轮次；停止只写入中断边界，不替用户结束整条侧链。
   */
  handleBtwMessage(
    context: BtwTurnContext,
    lifecycle: BtwTurnLifecycle,
  ): Promise<StopReason> {
    if (this.isBusy || this.activeTurn) throw new Error('Agent 工作中，不能启动 BTW')
    if (this.options.promptContext.discussion || this.protocolRound) {
      throw new Error('协议或讨论阶段不能启动 BTW')
    }
    if (findPendingUserQuestion(this.messages)) {
      throw new Error('当前问题尚未回答，不能启动 BTW')
    }
    const turnModelSelection: TurnModelSelection = {
      model: this.options.model,
      providerConfig: this.options.providerConfig,
      reasoningEffort: this.options.reasoningEffort ?? 'default',
    }
    this.activeModelSelection = turnModelSelection
    this.opAbort = new AbortController()
    this.running = true
    this.lastFinishReason = null
    for (const attachment of [
      ...context.history.flatMap((turn) => turn.attachments),
      ...context.attachments,
    ]) this.imageAttachments.set(attachment.storageName, structuredClone(attachment))
    return this.runBtwTurn(context, lifecycle, this.opAbort.signal)
      .finally(() => {
        if (this.activeModelSelection === turnModelSelection) this.activeModelSelection = null
      })
  }

  private async runBtwTurn(
    context: BtwTurnContext,
    lifecycle: BtwTurnLifecycle,
    abortSignal: AbortSignal,
  ): Promise<StopReason> {
    const startedAt = Date.now()
    lifecycle.emit({ type: 'agent-status', status: 'working' })
    let result: BtwTurnResult
    try {
      result = {
        ...await this.runBtwModel(context, lifecycle.emit, abortSignal),
        // 模型可能因不可交付输出重试；展示的是整次 BTW 生命周期，而非最后一次请求。
        durationMs: Math.max(0, Date.now() - startedAt),
      }
    } catch (error) {
      const stopped = abortSignal.aborted
      result = {
        outcome: stopped ? 'stopped' : 'error',
        assistantText: '',
        reasoningText: '',
        reasoningDurationMs: 0,
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(stopped ? { interruptionReason: 'user-cancel' as const } : {}),
        ...(!stopped ? { error: error instanceof Error ? error.message : String(error) } : {}),
      }
      lifecycle.emit({ type: 'step-discarded' })
    }

    if (result.error) lifecycle.emit({ type: 'error', message: result.error, recoverable: true })

    this.opAbort = null
    this.currentStepAbort = null
    const continuesWithMainWork = result.outcome !== 'error'
      && !abortSignal.aborted
      && this.hasPendingMessages()
    try {
      await lifecycle.onSettled(result, continuesWithMainWork)
    } catch (error) {
      this.running = false
      if (this.queue.length > 0) await this.restoreQueuedInput().catch(() => {})
      lifecycle.emit({ type: 'agent-status', status: 'error' })
      this.resolveIdleWaiters()
      throw error
    }
    if (continuesWithMainWork) {
      this.running = false
      this.activeModelSelection = null
      return this.startPendingTurn()
    }

    this.running = false
    if (this.queue.length > 0) {
      try {
        await this.restoreQueuedInput()
      } catch (error) {
        lifecycle.emit({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        })
        result = { ...result, outcome: 'error' }
      }
    }
    lifecycle.emit({ type: 'agent-status', status: result.outcome === 'error' ? 'error' : 'idle' })
    this.resolveIdleWaiters()
    return result.outcome === 'completed'
      ? 'completed'
      : result.outcome === 'stopped'
        ? 'aborted'
        : 'error'
  }

  private async runBtwModel(
    context: BtwTurnContext,
    emit: (event: CoreEvent) => void,
    turnAbortSignal: AbortSignal,
  ): Promise<BtwTurnResult> {
    const baseMessages = this.captureMessageSnapshot()
    const sideMessages = context.history.flatMap((turn): ModelMessage[] => {
      const messages = createBtwUserMessages(turn)
      messages.push(...turn.toolSteps?.flatMap((step) => step.messages) ?? [])
      if (turn.assistantText) {
        messages.push({ role: 'assistant', content: turn.assistantText })
      }
      if (turn.outcome === 'stopped') {
        messages.push(createTurnAbortedMessage(turn.interruptionReason ?? 'user-cancel'))
      }
      return messages
    })
    const system = buildSystemPrompt(
      this.options.promptContext,
      this.options.customSystemPrompt,
    )
    const requestMessages = [...baseMessages, ...sideMessages, ...createBtwUserMessages(context)]
    const toolSteps: BtwToolStep[] = []
    const loopHealth = new LoopHealthMonitor()
    while (true) {
      try {
        const result = await this.runModelStep(turnAbortSignal, emit, async (stepAbort) =>
          this.runBtwModelAttempt(
            system,
            await this.messagesForCurrentModel(requestMessages, stepAbort.signal),
            emit, stepAbort, loopHealth,
          ),
        )
        if (result.toolStep) {
          toolSteps.push(result.toolStep)
          requestMessages.push(...result.toolStep.messages)
          emit({ type: 'step-committed' })
          const pauseReason = loopHealth.consumePauseReason()
          if (pauseReason) throw new Error(pauseReason)
          continue
        }
        return { ...result, ...(toolSteps.length ? { toolSteps } : {}) }
      } catch (error) {
        return {
          outcome: turnAbortSignal.aborted ? 'stopped' : 'error',
          assistantText: '', reasoningText: '', reasoningDurationMs: 0, durationMs: 0,
          ...(toolSteps.length ? { toolSteps } : {}),
          ...(turnAbortSignal.aborted
            ? { interruptionReason: 'user-cancel' as const }
            : { error: error instanceof Error ? error.message : String(error) }),
        }
      }
    }
  }

  private async runBtwModelAttempt(
    system: string,
    messages: ModelMessage[],
    emit: (event: CoreEvent) => void,
    stepAbort: AbortController,
    loopHealth: LoopHealthMonitor,
  ): Promise<BtwTurnResult & { toolStep?: BtwToolStep }> {
    const startedAt = Date.now()
    let reasoningText = ''
    let reasoningStartedAt: number | null = null
    let reasoningDurationMs = 0
    let emittedText = ''
    let finishReason: string | null = null
    let hadToolCalls = false
    const toolErrors: string[] = []
    const stepAttachments = new ToolStepAttachments(this.options.sessionRecorder, this.imageAttachments, this.pdfAttachments)
    let toolExecution: ToolExecutionBatch | null = null
    let attachmentsCommitted = false
    let mcpStep: McpStepBinding | null = null
    try {
      mcpStep = await this.options.mcpRuntime?.beginStep(this.messages, stepAbort.signal) ?? null
      const tools = this.buildToolSet(
        stepAbort.signal,
        {
          emit,
          loopHealth,
          allowedToolNames: BTW_TOOL_NAMES,
          onToolExecutionStart: (id) => toolExecution!.start(id),
          onToolExecutionEnd: (event) => toolExecution!.finish(event),
          onPdfAttachments: (id, attachments) =>
            stepAttachments.acceptPdfs(id, attachments),
        },
        mcpStep?.toolDefinitions() ?? [],
      )
      const stream = streamText({
        maxRetries: 0,
        // readModelStream 统一报告错误，避免 SDK 默认日志重复输出请求内容。
        onError: () => {},
        model: this.createLanguageModel(),
        system,
        messages,
        tools: toolsForModel(tools),
        stopWhen: stepCountIs(1),
        providerOptions: this.requestProviderOptions(),
        abortSignal: stepAbort.signal,
      })
      const textGate = new AssistantTextGate((text) => {
        emittedText += text
        emit({ type: 'text-delta', text })
      })
      for await (const part of readModelStream(stream.fullStream)) {
        if (part.type === 'reasoning-delta') {
          if (reasoningStartedAt === null) {
            reasoningStartedAt = Date.now()
            emit({ type: 'agent-status', status: 'thinking' })
          }
          reasoningText += part.text
          emit({ type: 'thinking-delta', text: part.text })
        } else if (part.type === 'reasoning-end') {
          if (reasoningStartedAt !== null) {
            reasoningDurationMs += Date.now() - reasoningStartedAt
            reasoningStartedAt = null
            emit({ type: 'thinking-end', durationMs: reasoningDurationMs })
            emit({ type: 'agent-status', status: 'working' })
          }
        } else if (part.type === 'text-delta') {
          textGate.push(part.text)
        } else if (part.type === 'tool-call' && !part.providerExecuted) {
          hadToolCalls = true
        } else if (part.type === 'finish') {
          finishReason = part.finishReason
        }
      }
      textGate.finish()
      if (reasoningStartedAt !== null) {
        reasoningDurationMs += Date.now() - reasoningStartedAt
        emit({ type: 'thinking-end', durationMs: reasoningDurationMs })
      }
      if (stepAbort.signal.aborted) throw new Error('BTW 已中止')
      const response = await stream.response
      const normalized = normalizeResponseMessagesForProvider(
        response.messages,
        this.currentModelSelection().model.protocol,
      )
      const sanitized = sanitizeAssistantControlOutput(normalized)
      if (sanitized.rejected || (!hadToolCalls && !hasDeliverableModelText(sanitized.messages))) {
        throw emptyModelResponse(finishReason)
      }
      const assistantText = sanitized.messages.map(modelMessageText).join('\n').trim()
      const stepMessages = [...sanitized.messages]
      if (hadToolCalls) {
        toolExecution = new ToolExecutionBatch({
          messages: sanitized.messages, abort: stepAbort,
          emit: (event) => {
            if (event.type === 'tool-end' && event.isError) toolErrors.push(event.toolUseId)
            emit(event)
          },
          recordStart: async () => {},
          recordResult: async (message) => { appendOrderedMessages(stepMessages, [message]) },
        })
        await toolExecution.run(tools)
        if (stepAbort.signal.aborted) throw new Error('BTW 已中止')
      }
      const pdfAttachments = stepAttachments.pdfAttachments
      const toolStep: BtwToolStep | undefined = hadToolCalls ? {
        messages: dehydrateImageMessages([
          ...stepMessages,
          ...(pdfAttachments.length ? [{
            role: 'user' as const,
            content: withPdfAttachmentReferences('网页工具导入的 PDF 附件。', pdfAttachments),
          }] : []),
        ]),
        reasoningDurationMs,
        toolErrors,
        ...(pdfAttachments.length ? { pdfAttachments } : {}),
      } : undefined
      if (toolStep) {
        this.addPdfAttachments(pdfAttachments)
        this.rebuildActivePdfAttachments()
        attachmentsCommitted = true
      }
      return {
        outcome: 'completed',
        assistantText,
        ...(toolStep ? { toolStep } : {}),
        reasoningText,
        reasoningDurationMs,
        durationMs: Math.max(0, Date.now() - startedAt),
      }
    } catch (error) {
      if (stepAbort.signal.aborted) {
        if (emittedText) emit({ type: 'step-output-retained' })
        emit({ type: 'step-discarded' })
        return {
          outcome: 'stopped',
          assistantText: emittedText,
          reasoningText: '',
          reasoningDurationMs: 0,
          durationMs: Math.max(0, Date.now() - startedAt),
          interruptionReason: 'user-cancel',
        }
      }
      emit({ type: 'step-discarded' })
      throw error
    } finally {
      mcpStep?.discard()
      if (!attachmentsCommitted) await stepAttachments.discardUncommitted()
    }
  }

  /** 仅允许在回合结束后恢复，持久化回滚由共识任务终点统一提交。 */
  restoreMessageSnapshot(messages: ModelMessage[]): void {
    if (this.isBusy) throw new Error('Agent 工作中，不能恢复消息快照')
    this.messages = applyProjectInstructions(
      structuredClone(messages),
      findProjectInstructionsMessage(this.messages),
    )
    this.rebuildActivePdfAttachments()
    this.tokenBaseline = null
    this.emitContextUsage()
  }

  captureTaskStateSnapshot(): TaskPlanState | null {
    return this.taskPlan?.stateSnapshot ?? null
  }

  restoreTaskStateSnapshot(state: TaskPlanState): void {
    if (this.isBusy) throw new Error('Agent 工作中，不能恢复任务计划')
    this.taskPlan?.restore(state)
  }

  /**
   * 用户消息统一入口：空闲时开始新 turn；运行中/压缩中则排队（steering）。
   * urgent = 打断当前步骤立即注入（Claude Code 的 now 语义），默认等当前步骤结束（next 语义）。
   */
  handleUserMessage(
    text: string,
    urgent = false,
    imageAttachments: readonly ImageAttachment[] = [],
    persistedInputId?: string,
    pdfAttachments: readonly PdfAttachment[] = [],
    skills: readonly ActivatedSkill[] = [],
    imageDelivery: ImageDeliveryMode = 'native',
  ): Promise<StopReason> | void {
    if (imageAttachments.length > 0) {
      if (!this.options.sessionRecorder) throw new Error('图片消息需要会话级附件存储')
      this.addImageAttachments(imageAttachments)
    }
    if (pdfAttachments.length > 0) {
      if (!this.options.sessionRecorder) throw new Error('PDF 消息需要会话级附件存储')
      this.addPdfAttachments(pdfAttachments)
    }
    return this.handleMessage(
      text, urgent, imageAttachments, persistedInputId, pdfAttachments, skills, imageDelivery,
    )
  }

  /** 把单条排队消息安全退回 Renderer，供用户重新编辑后原子重提。 */
  async restoreQueuedMessage(id: string): Promise<boolean> {
    const queued = this.takeQueuedMessage(id)
    if (!queued) return false
    try {
      if (queued.message.persisted) {
        await this.persistRequired(
          (recorder) => recorder.markUserInputsRestored([queued.message.id]),
          '恢复排队输入',
        )
      }
    } catch (error) {
      this.putQueuedMessageBack(queued)
      throw error
    }
    const item = queuedUserMessage(queued.message)
    this.options.emit({ type: 'queue-restored', text: item.text, items: [item] })
    return true
  }

  /** 丢弃单条排队消息；先写稳事实源，重启后不得复活。 */
  async discardQueuedMessage(id: string): Promise<boolean> {
    const queued = this.takeQueuedMessage(id)
    if (!queued) return false
    try {
      if (queued.message.persisted) {
        await this.persistRequired(
          (recorder) => recorder.markUserInputsDiscarded([queued.message.id]),
          '丢弃排队输入',
        )
      }
    } catch (error) {
      this.putQueuedMessageBack(queued)
      throw error
    }
    this.options.emit({ type: 'message-dequeued', id: queued.message.id })
    return true
  }

  /** 复用 urgent steering：中断当前模型步骤，在下一个稳定边界注入现有队列。 */
  sendQueuedMessageNow(id: string): boolean {
    if (!this.queue.some((message) => message.id === id)) return false
    this.wakeRunLoop()
    if (this.running) this.currentStepAbort?.abort('interrupt')
    return true
  }

  /** 宿主生成的后台任务终态：运行中在稳定步骤边界注入，空闲时开启隐藏续轮。 */
  handleTaskNotification(
    notification: CommandTaskTerminalNotification,
  ): Promise<StopReason> | void {
    if (this.options.promptContext.discussion || this.protocolRound) {
      throw new Error('后台任务通知只在 Main 执行阶段可用')
    }
    const item: QueuedTaskNotification = {
      notification: structuredClone(notification),
      message: createCommandTaskNotificationMessage(notification),
    }
    if (this.isBusy || this.queue.length > 0 || findPendingUserQuestion(this.messages)) {
      this.taskNotifications.push(item)
      this.wakeRunLoop()
      return
    }
    return this.startTurn([item.message], [], undefined, [], [item], true)
  }

  /** 子代理终态与后台命令共用稳定步骤注入语义，但保留独立协议和交接确认。 */
  handleSubagentSettlement(
    notification: SubagentSettlementNotification,
    onDelivered?: () => void | Promise<void>,
  ): Promise<StopReason> | void {
    if (this.options.promptContext.discussion || this.protocolRound || this.options.promptContext.subagent) {
      throw new Error('子代理终态只在父 Main 执行阶段可用')
    }
    if (
      notification.parentTurnId === this.activeTurn?.id
      && (this.opAbort?.signal.aborted || this.abortRequestedDuringFinalization)
    ) {
      void (async () => { await onDelivered?.() })().catch((error) => this.options.emit({
        type: 'error',
        message: `丢弃已停止 turn 的子代理终态失败：${error instanceof Error ? error.message : String(error)}`,
        recoverable: true,
      }))
      return
    }
    const item: QueuedTaskNotification = {
      notification: structuredClone(notification),
      message: createSubagentSettlementMessage(notification),
      onDelivered,
    }
    if (this.isBusy || this.queue.length > 0 || findPendingUserQuestion(this.messages)) {
      this.taskNotifications.push(item)
      this.wakeRunLoop()
      return
    }
    return this.startTurn([item.message], [], undefined, [], [item], true)
  }

  /** 只读检查最新用户根回合的全部内部 turn，不由 Renderer 推测文件或命令副作用。 */
  async inspectLatestTurnEdit(turnId: string): Promise<TurnEditEffects> {
    return inspectLatestTurnEdit(this.turnEditRecorder(), turnId)
  }

  /** 文件恢复与换根共用项目写锁；对话事实提交前失败会补偿文件，不启动新回答。 */
  async prepareLatestTurnEdit(
    turnId: string,
    text: string,
    restoreFiles = false,
  ): Promise<PreparedLatestTurnEdit> {
    const nextText = text.trim()
    if (!nextText) throw new Error('编辑后的消息不能为空')
    const context = latestTurnEditContext(this.turnEditRecorder(), turnId, this.messages)
    this.editingTurn = true
    try {
      const operation = () => this.commitLatestTurnEdit(turnId, nextText, restoreFiles, context)
      return this.options.scheduleProjectMutation
        ? await this.options.scheduleProjectMutation(
          { type: 'turn-edit', turnId }, new AbortController().signal, operation,
        )
        : await operation()
    } finally {
      this.editingTurn = false
      this.resolveIdleWaiters()
    }
  }

  private async commitLatestTurnEdit(
    turnId: string,
    nextText: string,
    restoreFiles: boolean,
    { recorder, rollbackMessages, rollbackTaskState, skills, resources }: ReturnType<typeof latestTurnEditContext>,
  ): Promise<PreparedLatestTurnEdit> {
    const inputId = crypto.randomUUID()
    const commit = () => recorder.recordTurnEditInput(
      turnId, inputId, nextText, rollbackMessages, rollbackTaskState,
      resources.attachments, resources.pdfAttachments, skills, resources.imageDelivery,
    )
    if (restoreFiles) {
      if (!this.checkpoints) throw new Error('当前会话没有可回滚的文件检查点')
      await this.checkpoints.restoreEditedTurns(resources.turnIds, commit)
    } else {
      await commit()
    }
    this.messages = structuredClone([...recorder.initialMessages])
    this.taskPlan?.restore(recorder.initialTaskState)
    this.rebuildActivePdfAttachments()
    // 原消息的附件不在回滚前缀中；按普通根输入的同一路径重新登记，尤其要让
    // ReadPdf 在编辑后的首个模型步骤仍能读取原附件。
    this.addImageAttachments(resources.attachments)
    this.addPdfAttachments(resources.pdfAttachments)
    this.tokenBaseline = null
    this.emitContextUsage()
    const message = queuedMessageForModel({
      id: inputId,
      text: nextText,
      attachments: resources.attachments,
      imageDelivery: resources.imageDelivery ?? 'native',
      pdfAttachments: resources.pdfAttachments,
      skills,
      persisted: true,
    })
    return this.preparedEditedTurn(
      turnId,
      inputId,
      nextText,
      message,
      resources.attachments,
      resources.imageDelivery ?? 'native',
      resources.pdfAttachments,
      skills,
    )
  }

  private turnEditRecorder(): SessionRecorder {
    const recorder = this.options.sessionRecorder
    if (!recorder) throw new Error('当前会话没有可回滚的持久记录')
    if (this.isBusy || this.activeTurn || this.queue.length > 0) {
      throw new Error('Agent 尚未空闲，不能编辑最新消息')
    }
    if (
      this.options.promptContext.discussion
      || this.protocolRound
      || this.terminalStatusManaged
    ) {
      throw new Error('协商或评审回合不能使用单回合编辑')
    }
    if (this.persistenceFailed) {
      throw new Error('会话仍有待处理输入，不能编辑最新消息')
    }
    return recorder
  }

  private preparedEditedTurn(
    previousTurnId: string,
    inputId: string,
    text: string,
    message: ModelMessage,
    attachments: readonly ImageAttachment[],
    imageDelivery: ImageDeliveryMode,
    pdfAttachments: readonly PdfAttachment[],
    skills: readonly ActivatedSkill[],
  ): PreparedLatestTurnEdit {
    let accepted = false
    let startedMain = false
    const accept = (): void => {
      if (accepted) return
      accepted = true
      this.options.emit({
        type: 'user-message-edited',
        previousTurnId,
        inputId,
        text,
        taskPlan: taskPlanViewBeforeTurn(
          this.options.sessionRecorder!.initialViewEvents,
          previousTurnId,
          this.options.sessionRecorder!.initialTaskState,
        ),
      })
    }
    return {
      inputId,
      text,
      attachments: structuredClone([...attachments]),
      imageDelivery,
      pdfAttachments: structuredClone([...pdfAttachments]),
      skills: structuredClone([...skills]),
      accept,
      startMain: () => {
        if (startedMain) throw new Error('编辑后的回合已经启动')
        startedMain = true
        accept()
        const notifications = this.drainTaskNotifications()
        return this.startTurn(
          [message, ...notifications.map((item) => item.message)],
          [],
          inputId,
          skills,
          notifications,
        )
      },
    }
  }

  /** 协商执行包走同一模型意图路径，但不作为 urgent steering。 */
  handleExecutionMessage(
    text: string,
    steeringInputs: readonly QueuedUserMessage[] = [],
    skills: readonly ActivatedSkill[] = [],
  ): Promise<StopReason> | void {
    if (this.isBusy) throw new Error('Main 尚未空闲，不能启动协商执行阶段')
    const delivered = steeringInputs.map((input) => {
      if (input.attachments?.length && !input.imageDelivery) {
        throw new Error('协商执行输入缺少图片交付方式')
      }
      return {
        id: input.id,
        text: input.text,
        attachments: [...(input.attachments ?? [])],
        imageDelivery: input.imageDelivery ?? 'native',
        pdfAttachments: [...(input.pdfAttachments ?? [])],
        skills: [],
        persisted: this.options.sessionRecorder?.pendingUserInputs.some(
          (pending) => pending.id === input.id && pending.state === 'queued',
        ) ?? false,
      }
    })
    const attachments = delivered.flatMap((input) => input.attachments)
    const pdfAttachments = delivered.flatMap((input) => input.pdfAttachments)
    if (attachments.length > 0) {
      if (!this.options.sessionRecorder) throw new Error('图片消息需要会话级附件存储')
      this.addImageAttachments(attachments)
    }
    if (pdfAttachments.length > 0) {
      if (!this.options.sessionRecorder) throw new Error('PDF 消息需要会话级附件存储')
      this.addPdfAttachments(pdfAttachments)
    }
    const notifications = this.drainTaskNotifications()
    return this.startTurn(
      [
        { role: 'user', content: text },
        ...delivered.map(queuedMessageForModel),
        ...notifications.map((item) => item.message),
      ],
      delivered,
      undefined,
      skills,
      notifications,
    )
  }

  private handleMessage(
    text: string,
    urgent: boolean,
    imageAttachments: readonly ImageAttachment[] = [],
    persistedInputId?: string,
    pdfAttachments: readonly PdfAttachment[] = [],
    skills: readonly ActivatedSkill[] = [],
    imageDelivery: ImageDeliveryMode = 'native',
  ): Promise<StopReason> | void {
    const parsedSkills = skills.map((skill) => activatedSkillSchema.parse(skill))
    if (parsedSkills.length > 0 && (this.options.promptContext.discussion || this.protocolRound)) {
      throw new Error('Skill 只在 Main 执行阶段可用')
    }
    if (this.isBusy) {
      const item: QueuedMessage = {
        id: persistedInputId ?? crypto.randomUUID(),
        text,
        attachments: [...imageAttachments],
        imageDelivery,
        pdfAttachments: [...pdfAttachments],
        skills: parsedSkills.map((skill) => structuredClone(skill)),
        persisted: persistedInputId !== undefined,
      }
      this.queue.push(item)
      this.options.emit({
        type: 'message-queued',
        id: item.id,
        text,
        ...(item.attachments.length ? { attachments: item.attachments } : {}),
        ...(item.pdfAttachments.length ? { pdfAttachments: item.pdfAttachments } : {}),
        ...(item.skills.length ? { skills: item.skills.map(skillSummary) } : {}),
      })
      this.wakeRunLoop()
      if (urgent && this.running) {
        // 立即插话中止生成或派发，已开始的工具收尾并保存结果后再注入排队消息。
        this.currentStepAbort?.abort('interrupt')
      }
      return
    }
    const content = withPdfAttachmentReferences(text, pdfAttachments)
    const message = imageAttachments.length
      ? createImageUserMessage(content, imageAttachments, imageDelivery)
      : { role: 'user' as const, content }
    const rootInputId = persistedInputId
      && this.options.sessionRecorder?.undeliveredUserInputIds.includes(persistedInputId)
      ? persistedInputId
      : undefined
    const delivered = persistedInputId && !rootInputId
      ? [{
          id: persistedInputId,
          text,
          attachments: [...imageAttachments],
          imageDelivery,
          pdfAttachments: [...pdfAttachments],
          skills: parsedSkills.map((skill) => structuredClone(skill)),
          persisted: true,
        }]
      : []
    const notifications = this.drainTaskNotifications()
    return this.startTurn(
      [message, ...notifications.map((item) => item.message)],
      delivered,
      rootInputId,
      parsedSkills,
      notifications,
    )
  }

  /** 开启新 turn：中止控制器由 session 自管（含续跑/压缩后接续场景） */
  private startTurn(
    initialMessages: ModelMessage[],
    deliveredInputs: readonly QueuedMessage[] = [],
    rootInputId?: string,
    skills: readonly ActivatedSkill[] = [],
    taskNotifications: readonly QueuedTaskNotification[] = [],
    resumeTaskPlanFromNotification = false,
  ): Promise<StopReason> {
    const turnModelSelection: TurnModelSelection = {
      model: this.options.model,
      providerConfig: this.options.providerConfig,
      reasoningEffort: this.options.reasoningEffort ?? 'default',
    }
    this.activeModelSelection = turnModelSelection
    this.opAbort = new AbortController()
    this.running = true
    this.lastFinishReason = null
    this.lastTurnAssistantText = ''
    return this.runLoop(
      initialMessages,
      this.opAbort.signal,
      deliveredInputs,
      rootInputId,
      skills,
      taskNotifications,
      resumeTaskPlanFromNotification,
    ).finally(() => {
      if (this.activeModelSelection === turnModelSelection) {
        this.activeModelSelection = null
      }
    })
  }

  private async prepareSkillTurn(skills: readonly ActivatedSkill[]): Promise<void> {
    const selection = this.currentModelSelection()
    await this.skillTurn.start({
      skills,
      projectDir: this.options.promptContext.projectDir,
      contextWindow: selection.model.capabilities.contextWindow,
      enabled: !this.options.promptContext.discussion && !this.protocolRound,
      onCatalogError: (error) => this.options.emit({
        type: 'error',
        message: `Skill 目录刷新失败：${error instanceof Error ? error.message : String(error)}`,
        recoverable: true,
      }),
    })
    await this.refreshSubagentCatalog()
  }

  private async refreshSubagentCatalog(): Promise<void> {
    const catalog = this.options.subagentCatalog
    if (!catalog || this.options.promptContext.discussion || this.options.promptContext.subagent) {
      return
    }
    try {
      const snapshot = await catalog.snapshot(this.options.promptContext.projectDir, this.options.workspaceIO)
      this.options = {
        ...this.options,
        promptContext: { ...this.options.promptContext, subagents: snapshot },
      }
    } catch (error) {
      this.options.emit({
        type: 'error',
        message: `子代理定义目录刷新失败：${error instanceof Error ? error.message : String(error)}`,
        recoverable: true,
      })
    }
  }

  /** 用户点「停止」：中止当前 turn 或压缩 */
  abort(context?: TurnInterruptionContext): void {
    if (context?.interruptedSubagents.length && (this.running || this.activeTurn)) {
      this.turnInterruptionContext = {
        interruptedSubagents: context.interruptedSubagents.map((subagent) => ({ ...subagent })),
      }
    }
    if (this.opAbort) this.opAbort.abort('user-cancel')
    else if (this.running) this.abortRequestedDuringFinalization = true
    this.discardCurrentTurnSubagentNotifications()
    this.wakeRunLoop()
  }

  private discardCurrentTurnSubagentNotifications(): void {
    const turnId = this.activeTurn?.id
    if (!turnId) return
    const retained: QueuedTaskNotification[] = []
    const discarded: QueuedTaskNotification[] = []
    for (const item of this.taskNotifications) {
      const notification = item.notification
      if ('activationId' in notification && notification.parentTurnId === turnId) {
        discarded.push(item)
      } else {
        retained.push(item)
      }
    }
    this.taskNotifications = retained
    if (discarded.length > 0) void this.confirmNotificationsDelivered(discarded)
  }

  /** 不能安全自动接续时，排队消息弹回输入框，不静默丢弃。 */
  private async restoreQueuedInput(): Promise<void> {
    const items = [...this.queue]
    if (items.length === 0) return
    const persistedIds = items.filter((item) => item.persisted).map((item) => item.id)
    if (persistedIds.length > 0) {
      await this.persistRequired(
        (recorder) => recorder.markUserInputsRestored(persistedIds),
        '恢复排队输入',
      )
    }
    const restoredIds = new Set(items.map((item) => item.id))
    this.queue = this.queue.filter((item) => !restoredIds.has(item.id))
    this.rebuildActivePdfAttachments()
    this.options.emit({
      type: 'queue-restored',
      text: items.map((item) => item.text).join('\n'),
      items: items.map(queuedUserMessage),
    })
  }

  private takeQueuedMessage(id: string): { message: QueuedMessage; index: number } | null {
    const index = this.queue.findIndex((message) => message.id === id)
    if (index < 0) return null
    const [message] = this.queue.splice(index, 1)
    if (!message) return null
    this.rebuildActivePdfAttachments()
    return { message, index }
  }

  private putQueuedMessageBack(queued: { message: QueuedMessage; index: number }): void {
    this.queue.splice(Math.min(queued.index, this.queue.length), 0, queued.message)
    this.rebuildActivePdfAttachments()
  }

  /** 取出全部排队消息（清空队列） */
  private drainQueue(): QueuedMessage[] {
    const drained = this.queue
    this.queue = []
    return drained
  }

  private drainTaskNotifications(): QueuedTaskNotification[] {
    const drained = this.taskNotifications
    this.taskNotifications = []
    return drained
  }

  private hasPendingMessages(): boolean {
    return this.queue.length > 0 || this.taskNotifications.length > 0
  }

  private startPendingTurn(): Promise<StopReason> {
    const users = this.drainQueue()
    const notifications = this.drainTaskNotifications()
    return this.startTurn(
      [
        ...users.map(queuedMessageForModel),
        ...notifications.map((item) => item.message),
      ],
      users,
      undefined,
      users.flatMap((item) => item.skills),
      notifications,
      users.length === 0,
    )
  }

  /** 一批跨边界消息形成一个新 turn：只有第一条建立可见回滚锚点。 */
  private emitDrainedMessages(messages: QueuedMessage[]): void {
    messages.forEach((item, index) => {
      this.options.emit({
        type: 'message-injected',
        id: item.id,
        text: item.text,
        startsTurn: index === 0,
        ...(item.attachments.length ? { attachments: item.attachments } : {}),
        ...(item.pdfAttachments.length ? { pdfAttachments: item.pdfAttachments } : {}),
        ...(item.skills.length ? { skills: item.skills.map(skillSummary) } : {}),
      })
    })
  }

  private resolveIdleWaiters(): void {
    if (this.isBusy) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }

  private wakeRunLoop(): void {
    this.runLoopWake?.()
  }

  /** 等待用户插话或内部终态；注册后再次检查，封住检查与订阅之间的竞态。 */
  private waitForRunLoopWake(abortSignal: AbortSignal): Promise<void> {
    if (this.hasPendingMessages() || abortSignal.aborted) return Promise.resolve()
    if (this.runLoopWake) throw new Error('runLoop 已经在等待唤醒')
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        abortSignal.removeEventListener('abort', finish)
        if (this.runLoopWake === finish) this.runLoopWake = null
        resolve()
      }
      this.runLoopWake = finish
      abortSignal.addEventListener('abort', finish, { once: true })
      if (this.hasPendingMessages() || abortSignal.aborted) finish()
    })
  }

  private async subagentTurnState(turnId: string): Promise<SubagentTurnState | null> {
    const load = this.options.getSubagentTurnState
    if (!load || this.options.promptContext.discussion || this.options.promptContext.subagent) {
      return null
    }
    const state = subagentTurnStateSchema.parse(await load(turnId))
    if (state.parentTurnId !== turnId) throw new Error('子代理 turn 状态归属不匹配')
    if (state.activations.length === 0) return null
    return {
      ...state,
      activations: state.activations.map((activation) =>
        activation.outcome !== undefined
          && this.deliveredSubagentActivations.has(activation.activationId)
          ? { ...activation, settlement: 'delivered' as const }
          : activation),
    }
  }

  private rememberDeliveredSubagentNotifications(
    notifications: readonly QueuedTaskNotification[],
    turnId: string,
  ): void {
    for (const item of notifications) {
      const notification = item.notification
      if ('activationId' in notification && notification.parentTurnId === turnId) {
        this.deliveredSubagentActivations.add(notification.activationId)
      }
    }
  }

  /** 步骤间注入真实用户消息；其语义由模型结合当前计划状态自行判断。 */
  private async injectQueuedMidTurn(): Promise<boolean> {
    const drained = this.drainQueue()
    const notifications = this.drainTaskNotifications()
    const injected: ModelMessage[] = [
      ...drained.map(queuedMessageForModel),
      ...notifications.map((item) => item.message),
    ]
    if (injected.length > 0 && this.activeTurn) {
      try {
        await this.persistRequired(
          (recorder) => recorder.recordStep(
            this.activeTurn!.id,
            injected,
            undefined,
            undefined,
            {
              attachments: drained.flatMap((item) => item.attachments),
              deliveredInputIds: drained.filter((item) => item.persisted).map((item) => item.id),
            },
          ),
          '确认排队输入送达',
        )
      } catch (error) {
        this.queue = [...drained, ...this.queue]
        this.taskNotifications = [...notifications, ...this.taskNotifications]
        throw error
      }
      this.messages.push(...injected)
      this.rememberDeliveredSubagentNotifications(notifications, this.activeTurn.id)
      await this.confirmNotificationsDelivered(notifications)
      this.skillTurn.add(drained.flatMap((item) => item.skills))
      drained.forEach((item) => this.options.emit({
        type: 'message-injected',
        id: item.id,
        text: item.text,
        ...(item.attachments.length ? { attachments: item.attachments } : {}),
        ...(item.pdfAttachments.length ? { pdfAttachments: item.pdfAttachments } : {}),
        ...(item.skills.length ? { skills: item.skills.map(skillSummary) } : {}),
      }))
    }
    return drained.length > 0
  }

  /** 外层循环：turn（含 steering 续跑）→ step → 工具，直到无工具调用且队列为空 */
  private async runLoop(
    initialMessages: ModelMessage[],
    abortSignal: AbortSignal,
    deliveredInputs: readonly QueuedMessage[] = [],
    rootInputId?: string,
    skills: readonly ActivatedSkill[] = [],
    initialTaskNotifications: readonly QueuedTaskNotification[] = [],
    resumeTaskPlanFromNotification = false,
  ): Promise<StopReason> {
    const { emit } = this.options
    this.abortRequestedDuringFinalization = false
    this.turnInterruptionContext = null
    this.activeSubagentTurnState = null
    this.deliveredSubagentActivations.clear()
    const turnId = crypto.randomUUID()
    const previousProjectInstructions = findProjectInstructionsMessage(this.messages)
    let projectInstructions: ProjectInstructionsUpdate | null = null
    let initialMessageCount = this.messages.length
    await this.prepareSkillTurn(skills)
    try {
      const resolved = await this.resolveProjectInstructions()
      projectInstructions = resolved.update
      this.applyResolvedProjectInstructions(resolved.message)
      initialMessageCount = this.messages.length
    } catch (error) {
      if (deliveredInputs.length > 0) this.queue = [...deliveredInputs, ...this.queue]
      if (initialTaskNotifications.length > 0) {
        this.taskNotifications = [...initialTaskNotifications, ...this.taskNotifications]
      }
      this.opAbort = null
      this.running = false
      this.activeSubagentTurnState = null
      this.turnInterruptionContext = null
      this.skillTurn.finish()
      this.emitContextUsage()
      emit({
        type: 'error',
        message: `无法读取项目指令：${error instanceof Error ? error.message : String(error)}`,
        recoverable: true,
      })
      if (!this.terminalStatusManaged) emit({ type: 'agent-status', status: 'error' })
      this.resolveIdleWaiters()
      return 'error'
    }
    const pendingUserQuestion = findPendingUserQuestion(this.messages)
    const answersPendingUserQuestion = pendingUserQuestion !== null
      && initialMessages.some((message) =>
        message.role === 'user'
        && isUserQuestionAnswer(pendingUserQuestion, modelMessageText(message)))
    const resumesUserQuestion = answersPendingUserQuestion
      && pendingUserQuestion.resumesTaskPlan
    const notificationContinuationPlanId = resumeTaskPlanFromNotification
      ? initialTaskNotifications
          .map((item) => item.notification.engagedPlanId)
          .find((planId) => planId === this.taskPlan?.snapshot?.id)
      : undefined
    const resumesTaskNotification = Boolean(
      notificationContinuationPlanId
      && !this.taskPlan?.stateSnapshot.resumeRequired,
    )
    let planExecutionEngaged = (resumesUserQuestion || resumesTaskNotification)
      && Boolean(this.taskPlan?.snapshot)
      && !this.taskPlan?.stateSnapshot.resumeRequired
    const notificationContinuation = resumesTaskNotification
      && notificationContinuationPlanId
      ? createTaskContextMessage(this.taskPlan!.stateSnapshot, {
          turnId,
          engagedPlanId: notificationContinuationPlanId,
        })
      : null
    const initialContext = this.taskPlan?.snapshot
      ? planExecutionEngaged
        ? [...(notificationContinuation ? [notificationContinuation] : []), ...initialMessages]
        : [
            createTaskExecutionBoundaryMessage(
              this.taskPlan.stateSnapshot.resumeRequired ? 'interrupted' : 'dormant',
            ),
            ...initialMessages,
          ]
      : initialMessages
    // turn 起点先于 initialMessages 入栈：对话回滚锚定这里，触发指令一并移除
    this.activeTurn = { id: turnId, fileChanges: new Map() }
    this.messages.push(...initialContext)
    try {
      await this.persistRequired(
        (recorder) => recorder.recordTurnStart(
          turnId,
          initialContext,
          planExecutionEngaged ? this.taskPlan?.snapshot?.id : undefined,
          deliveredInputs.filter((input) => input.persisted).map((input) => input.id),
          projectInstructions ?? undefined,
          rootInputId,
          skills,
        ),
        '提交回合起点',
      )
    } catch (error) {
      this.messages.length = initialMessageCount
      this.messages = applyProjectInstructions(this.messages, previousProjectInstructions)
      if (deliveredInputs.length > 0) this.queue = [...deliveredInputs, ...this.queue]
      if (initialTaskNotifications.length > 0) {
        this.taskNotifications = [...initialTaskNotifications, ...this.taskNotifications]
      }
      this.activeTurn = null
      this.opAbort = null
      this.running = false
      this.activeSubagentTurnState = null
      this.skillTurn.finish()
      this.emitContextUsage()
      this.abortRequestedDuringFinalization = false
      this.turnInterruptionContext = null
      emit({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      })
      if (!this.terminalStatusManaged) emit({ type: 'agent-status', status: 'error' })
      this.resolveIdleWaiters()
      return 'error'
    }
    this.rememberDeliveredSubagentNotifications(initialTaskNotifications, turnId)
    await this.confirmNotificationsDelivered(initialTaskNotifications)
    if (deliveredInputs.length > 0) this.emitDrainedMessages([...deliveredInputs])

    emit({ type: 'turn-start', turnId })
    emit({ type: 'agent-status', status: 'working' })

    let stopReason: StopReason = 'completed'
    let endedByTool = false
    const maxSteps = this.options.promptContext.discussion || this.protocolRound
      ? BOUNDED_MAX_STEPS
      : null
    this.loopHealth = new LoopHealthMonitor()
    const usage: UsageInfo = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 }
    const interruptedBoundaryPending = findPendingTurnAbortedIndex(this.messages) !== null

    try {
      let steps = 0
      let finishedNaturally = false
      let interruptionBoundaryConsumed = false
      let steeringDecisionPending = false
      let stepsSincePlanMutation = 0
      let stepsSincePlanReminder = 0
      let projectInstructionsFresh = true
      // 未结束计划跨 turn 保留，但执行权只属于当前 runLoop。每个新 turn 默认休眠；
      // 只有稳定提交 Create/Resume，或回答计划自身的问题卡，才接合计划执行生命周期。
      while (maxSteps === null || steps < maxSteps) {
        if (!projectInstructionsFresh) await this.refreshProjectInstructions()
        projectInstructionsFresh = false
        if (
          planExecutionEngaged
          && this.taskPlan?.hasUnfinishedWork()
          && stepsSincePlanMutation >= TASK_PROGRESS_REMINDER_STEPS
          && stepsSincePlanReminder >= TASK_PROGRESS_REMINDER_STEPS
        ) {
          await this.injectTaskProgressReminder()
          stepsSincePlanReminder = 0
        }
        await this.compactIfNeeded(abortSignal, planExecutionEngaged, turnId)
        if (this.hasPendingMessages()) {
          const injectedUserMessage = await this.injectQueuedMidTurn()
          if (injectedUserMessage) steeringDecisionPending = true
        }
        const subagentState = await this.subagentTurnState(turnId)
        this.activeSubagentTurnState = subagentState
        steps++
        if (maxSteps !== null && steps === maxSteps - FINALIZATION_RESERVE_STEPS) {
          await this.injectStepLimitReminder()
        }
        const step = await this.runOneStep(
          usage,
          abortSignal,
          planExecutionEngaged,
          interruptedBoundaryPending
            && !interruptionBoundaryConsumed
            && !this.options.promptContext.discussion
            && !this.protocolRound,
          steeringDecisionPending || hasOutstandingSubagentActivations(subagentState),
          subagentState,
        )
        // UpdateTaskItem 只是把暂停前的真实进度写稳；让下一次最终文本继续决定是否结束。
        // 其它任何工具均表示模型选择继续实质处理，仍按原逻辑消费本窗口。
        steeringDecisionPending = steeringDecisionPending
          && step.hadOnlyTaskProgressUpdates
        if (step.interruptionBoundaryConsumed) interruptionBoundaryConsumed = true
        if (step.taskPlanChanged) {
          planExecutionEngaged = Boolean(this.taskPlan?.snapshot)
          stepsSincePlanMutation = 0
          stepsSincePlanReminder = 0
        } else if (step.committed && planExecutionEngaged) {
          stepsSincePlanMutation++
          stepsSincePlanReminder++
        }
        const engagement = step.taskPlanEngagement
        if (engagement && engagement.planId === this.taskPlan?.snapshot?.id) {
          planExecutionEngaged = true
          stepsSincePlanMutation = 0
          stepsSincePlanReminder = 0
        }
        if (step.toolEndReason) {
          if (abortSignal.aborted) this.abortRequestedDuringFinalization = true
          endedByTool = true
          stopReason = step.toolEndReason
          break
        }
        // 注入点：本步工具结果已收齐、下一次模型请求前（文档一 §3.1）
        if (this.hasPendingMessages()) {
          if (abortSignal.aborted) {
            if (
              !step.hadToolCalls
              && !planExecutionEngaged
              && !hasOutstandingSubagentActivations(subagentState)
            ) {
              this.abortRequestedDuringFinalization = true
              stopReason = 'completed'
              finishedNaturally = true
            } else {
              stopReason = 'aborted'
            }
            break
          }
          const injectedUserMessage = await this.injectQueuedMidTurn()
          if (injectedUserMessage) steeringDecisionPending = true
          continue // 有新消息注入时，即使模型没调工具也要续一步来回应
        }
        if (abortSignal.aborted && step.hadToolCalls) {
          stopReason = 'aborted'
          break
        }
        const loopReason = this.loopHealth.consumePauseReason()
        if (loopReason) {
          if (abortSignal.aborted) this.abortRequestedDuringFinalization = true
          stopReason = 'paused'
          emit({
            type: 'error',
            message: `长任务已安全暂停：${loopReason}请检查当前计划后再继续。`,
            recoverable: true,
          })
          break
        }
        if (!step.hadToolCalls) {
          if (abortSignal.aborted) {
            stopReason = 'aborted'
            break
          }
          const latestSubagentState = await this.subagentTurnState(turnId)
          this.activeSubagentTurnState = latestSubagentState
          if (hasOutstandingSubagentActivations(latestSubagentState)) {
            await this.waitForRunLoopWake(abortSignal)
            if (abortSignal.aborted) {
              stopReason = 'aborted'
              break
            }
            continue
          }
          if (step.awaitingTaskPlanContinuation) {
            stopReason = 'paused'
            finishedNaturally = true
            break
          }
          finishedNaturally = true
          break
        }
      }
      if (
        stopReason === 'completed' &&
        maxSteps !== null &&
        steps >= maxSteps &&
        !endedByTool &&
        !finishedNaturally
      ) {
        stopReason = 'max-turns'
        emit({
          type: 'error',
          message: `当前协商回合已达到 ${maxSteps} 步安全上限，可能尚未完成。`,
          recoverable: true,
        })
      }
    } catch (error) {
      if (abortSignal.aborted) {
        stopReason = 'aborted'
      } else {
        stopReason = 'error'
        emit({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        })
      }
    }

    // 循环已产生稳定终态；后续短暂持久化窗口不再接受“停止”去回滚已提交 step。
    this.opAbort = null
    if (stopReason === 'aborted') {
      const interruptedState = planExecutionEngaged
        ? this.taskPlan?.interrupt('user-cancel') ?? null
        : null
      const markers: ModelMessage[] = [
        createTurnAbortedMessage('user-cancel', this.turnInterruptionContext ?? undefined),
      ]
      if (interruptedState) {
        const taskContext = createTaskContextMessage(interruptedState)
        if (taskContext) markers.push(taskContext)
      }
      this.messages.push(...markers)
      await this.persist((recorder) =>
        recorder.recordStep(turnId, markers, interruptedState ?? undefined, null),
      )
    }
    await this.persist((recorder) => recorder.recordTurnEnd(turnId, stopReason))
    this.activeTurn = null
    this.opAbort = null
    this.activeSubagentTurnState = null
    this.turnInterruptionContext = null
    this.deliveredSubagentActivations.clear()
    this.skillTurn.finish()

    this.emitContextUsage()
    emit({ type: 'turn-end', turnId, usage, stopReason })

    // 收尾持久化窗口进入的消息也必须有确定归宿；普通 Main 作为新 turn 接续。
    if (
      this.hasPendingMessages()
      && stopReason !== 'aborted'
      && !this.protocolRound
      && !this.abortRequestedDuringFinalization
      && !this.persistenceFailed
      && (this.queue.length > 0 || stopReason !== 'waiting-user')
    ) {
      return this.startPendingTurn()
    }

    if (
      this.activeModelSelection
      && this.options.model.id !== this.activeModelSelection.model.id
    ) {
      this.activeModelSelection = null
      await this.initializeContextUsage()
    }
    this.running = false
    this.abortRequestedDuringFinalization = false
    if (this.queue.length > 0 && !this.persistenceFailed) {
      try {
        await this.restoreQueuedInput()
      } catch (error) {
        stopReason = 'error'
        emit({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        })
      }
    }
    if (!this.terminalStatusManaged) {
      emit({ type: 'agent-status', status: stopReason === 'error' ? 'error' : 'idle' })
    }
    this.resolveIdleWaiters()
    return stopReason
  }

  private async confirmNotificationsDelivered(
    notifications: readonly QueuedTaskNotification[],
  ): Promise<void> {
    for (const notification of notifications) {
      try {
        await notification.onDelivered?.()
      } catch (error) {
        this.options.emit({
          type: 'error',
          message: `内部任务终态交接确认失败：${error instanceof Error ? error.message : String(error)}`,
          recoverable: true,
        })
      }
    }
  }

  /** 给模型预留收尾窗口，避免一直扩展探索直到安全上限才突然停止。 */
  private async injectStepLimitReminder(): Promise<void> {
    const reminder: ModelMessage = {
      role: 'user',
      content: [
        '<system-reminder>',
        `当前协商回合还剩 ${FINALIZATION_RESERVE_STEPS + 1} 次模型请求即达到安全上限。`,
        '请停止扩展性探索，只做必要收尾；能完成时立即给出完整结论，协议阶段则立即提交正式协议输出。',
        '</system-reminder>',
      ].join('\n'),
    }
    this.messages.push(reminder)
    if (this.activeTurn) {
      await this.persist((recorder) => recorder.recordStep(this.activeTurn!.id, [reminder]))
    }
  }

  private async injectTaskProgressReminder(): Promise<void> {
    const plan = this.taskPlan?.snapshot
    if (!plan) return
    const current = plan.items.find((item) => item.status === 'in_progress')
    const reminder: ModelMessage = {
      role: 'user',
      content: [
        '<system-reminder>',
        `计划 ${plan.id} 已有 ${TASK_PROGRESS_REMINDER_STEPS} 个模型步骤没有更新。`,
        current ? `当前任务项：${current.id} ${current.outcome}。` : '',
        '若进度或任务项已实质变化，请更新计划；若复杂测试或排查尚无结论，继续工作即可，不要制造进度。',
        '不要向用户提及本提醒。',
        '</system-reminder>',
      ].filter(Boolean).join('\n'),
    }
    this.messages.push(reminder)
    if (this.activeTurn) {
      await this.persist((recorder) => recorder.recordStep(this.activeTurn!.id, [reminder]))
    }
  }

  /** 手动压缩（用户主动触发，不看阈值）：统一先微清理，再尝试完整压缩。 */
  async compactNow(): Promise<void> {
    const { emit } = this.options
    if (this.isBusy) {
      emit({ type: 'error', message: 'Agent 工作中，请先停止再压缩', recoverable: true })
      return
    }
    if (this.messages.length < 2) {
      emit({ type: 'error', message: '对话太短，无需压缩', recoverable: true })
      return
    }
    this.compacting = true
    this.opAbort = new AbortController()
    const signal = this.opAbort.signal
    const preTokens = this.estimateCurrentContextTokens()
    emit({ type: 'agent-status', status: 'working' })
    try {
      await this.refreshProjectInstructions()
      const microcompacted = this.microcompactCurrentMessages()
      const result = await compactMessages(
        this.createLanguageModel(),
        withoutMcpToolState(this.messages),
        [...this.recentReadFiles].map(([path, readAt]) => ({ path, readAt })),
        signal,
        this.compactApplicationContext(),
        (messages) => this.messagesForCurrentModel(messages, signal, false),
        this.requestProviderOptions(),
        (retry) => emit({ type: 'model-request-retry', ...retry }),
        this.options.workspaceIO,
      )
      if (result.summaryText || microcompacted) {
        this.messages = carryMcpToolState(this.messages, result.messages)
        await this.refreshProjectInstructions()
        this.rebuildActivePdfAttachments()
        await this.persist((recorder) =>
          recorder.recordSnapshot('compact', this.messages, undefined, this.taskPlan?.stateSnapshot),
        )
        this.tokenBaseline = null
        this.compactFailures = 0
        emit({
          type: 'context-compacted',
          level: result.summaryText ? 'full' : 'micro',
          preTokens,
          postTokens: this.estimateCurrentContextTokens(),
        })
        this.emitContextUsage()
      } else {
        emit({ type: 'error', message: '当前上下文已在精确保留预算内，无需压缩', recoverable: true })
      }
    } catch (error) {
      emit({
        type: 'error',
        message: signal.aborted
          ? '压缩已取消'
          : `压缩失败：${error instanceof Error ? error.message : String(error)}`,
        recoverable: true,
      })
    }
    this.compacting = false
    this.opAbort = null

    // 压缩期间排队的消息：取消则弹回输入框；正常结束则在新上下文上接续为新 turn
    if (signal.aborted) {
      await this.restoreQueuedInput()
    } else if (
      this.hasPendingMessages()
      && (this.queue.length > 0 || !findPendingUserQuestion(this.messages))
    ) {
      await this.startPendingTurn()
      return
    }
    emit({ type: 'agent-status', status: 'idle' })
    this.resolveIdleWaiters()
  }

  /**
   * 上下文压缩检查（每次模型请求前，文档一 §3.4）：
   * 超阈值 → 先微清理（零成本）→ 仍超 → 全量摘要压缩；连续失败熔断。
   */
  private async compactIfNeeded(
    abortSignal: AbortSignal,
    planExecutionEngaged: boolean,
    turnId: string,
  ): Promise<void> {
    const { emit } = this.options
    const model = this.currentModelSelection().model
    const threshold = autoCompactThreshold(model.capabilities)
    const skillTokens = this.skillTurn.injectedContextTokenEstimate()
    if (skillTokens >= threshold) {
      throw new Error(
        `当前选择的 Skill 内容约 ${skillTokens} tokens，超过该模型单次任务的上下文预算；请减少选择或缩短 SKILL.md`,
      )
    }
    let estimate = this.estimateCurrentContextTokens()
    if (estimate < threshold || this.compactFailures >= MAX_COMPACT_FAILURES) return

    const preTokens = estimate
    // 第一级：微清理旧工具输出（改写历史后基线失效，全量重估）
    const microcompacted = this.microcompactCurrentMessages()
    if (microcompacted) {
      estimate = this.estimateCurrentContextTokens()
      if (estimate < threshold) {
        this.compactFailures = 0
        await this.commitAutoMicrocompaction(preTokens, turnId)
        return
      }
    }

    // 第二级：全量摘要压缩
    try {
      const result = await compactMessages(
        this.createLanguageModel(),
        withoutMcpToolState(this.messages),
        [...this.recentReadFiles].map(([path, readAt]) => ({ path, readAt })),
        abortSignal,
        this.compactApplicationContext(planExecutionEngaged, turnId),
        (messages) => this.messagesForCurrentModel(messages, abortSignal, false),
        this.requestProviderOptions(),
        (retry) => this.options.emit({ type: 'model-request-retry', ...retry }),
        this.options.workspaceIO,
      )
      if (!result.summaryText) {
        this.recordAutoCompactFailure()
        if (microcompacted) {
          await this.commitAutoMicrocompaction(preTokens, turnId)
        }
        return
      }
      this.messages = carryMcpToolState(this.messages, result.messages)
      await this.refreshProjectInstructions()
      this.rebuildActivePdfAttachments()
      await this.persist((recorder) =>
        recorder.recordSnapshot(
          'compact',
          this.messages,
          this.activeTurn?.id,
          this.taskPlan?.stateSnapshot,
        ),
      )
      this.tokenBaseline = null
      this.compactFailures = 0
      // 消息数组已重建：旧对话回滚锚点失效（仅文件回滚仍可用）
      const postTokens = this.estimateCurrentContextTokens()
      emit({ type: 'context-compacted', level: 'full', preTokens, postTokens })
      this.emitContextUsage()
    } catch (error) {
      if (abortSignal.aborted) throw error
      this.recordAutoCompactFailure()
      if (microcompacted) await this.commitAutoMicrocompaction(preTokens, turnId)
      // 失败不阻塞：请求可能仍能成功（估算偏保守）。
    }
  }

  private async commitAutoMicrocompaction(preTokens: number, turnId: string): Promise<void> {
    await this.persist((recorder) =>
      recorder.recordSnapshot('compact', this.messages, turnId, this.taskPlan?.stateSnapshot),
    )
    this.options.emit({
      type: 'context-compacted',
      level: 'micro',
      preTokens,
      postTokens: this.estimateCurrentContextTokens(),
    })
    this.emitContextUsage()
  }

  private recordAutoCompactFailure(): void {
    this.compactFailures++
    if (this.compactFailures !== MAX_COMPACT_FAILURES) return
    this.options.emit({
      type: 'error',
      message: '自动压缩连续失败，已暂停自动重试；请手动压缩查看具体错误，或切换模型。',
      recoverable: true,
    })
  }

  /** 自动与手动压缩共用的唯一微清理入口。 */
  private microcompactCurrentMessages(): boolean {
    const cleaned = microcompact(this.messages)
    if (!cleaned) return false
    this.messages = cleaned
    this.tokenBaseline = null
    return true
  }

  private compactApplicationContext(
    planExecutionEngaged = false,
    turnId?: string,
  ): string | undefined {
    const state = this.taskPlan?.stateSnapshot
    const taskContext = state && state.version > 0
      ? taskContextBlock(
          state,
          planExecutionEngaged && turnId && state.activePlan
            ? { turnId, engagedPlanId: state.activePlan.id }
            : undefined,
        )
      : undefined
    const pdfContext = compactPdfAttachmentContext(this.sessionPdfAttachments())
    const sections = [taskContext, pdfContext].filter(
      (section): section is string => Boolean(section),
    )
    return sections.length > 0 ? sections.join('\n\n') : undefined
  }

  private estimateCurrentContextTokens(messages: ModelMessage[] = this.messages): number {
    const fallbackOverheadTokens = this.contextOverhead
      ? this.contextOverhead.systemPromptTokens + this.contextOverhead.toolTokens
      : 0
    const rawEstimate = estimateContextTokens(
      messages,
      this.tokenBaseline,
      fallbackOverheadTokens,
    )
    const currentSkillDelta = this.skillTurn.estimatedProjectionTokenDelta(messages)
    const baselineDelta = this.tokenBaseline
      ? this.tokenBaselineSkillProjectionDelta
      : 0
    const subagentStateMessage = this.activeSubagentTurnState
      ? createSubagentTurnStateMessage(this.activeSubagentTurnState)
      : null
    const currentSubagentDelta = subagentStateMessage
      ? estimateMessagesTokens([subagentStateMessage])
      : 0
    const baselineSubagentDelta = this.tokenBaseline
      ? this.tokenBaselineSubagentProjectionDelta
      : 0
    return Math.max(
      0,
      rawEstimate
        + currentSkillDelta
        - baselineDelta
        + currentSubagentDelta
        - baselineSubagentDelta,
    )
  }

  private emitContextUsage(
    requestMessages?: readonly ModelMessage[],
    requestUsedTokens?: number,
  ): void {
    if (
      this.activeModelSelection
      && this.options.model.id !== this.activeModelSelection.model.id
    ) {
      this.options.emit({ type: 'context-usage', usage: null })
      return
    }
    if (!this.contextOverhead) {
      this.options.emit({ type: 'context-usage', usage: null })
      return
    }
    const subagentStateMessage = this.activeSubagentTurnState
      ? createSubagentTurnStateMessage(this.activeSubagentTurnState)
      : null
    const projectedMessages = this.skillTurn.project(
      withoutMcpToolState([
        ...this.messages,
        ...(subagentStateMessage ? [subagentStateMessage] : []),
      ]),
      true,
    )
    const breakdown: ContextUsageInfo['breakdown'] = {
      ...this.contextOverhead,
      // 真实请求已装配时直接计算其 Provider 边界 messages；其余时刻投影下一次请求。
      messageTokens: estimateMessagesTokens(requestMessages ?? projectedMessages),
    }
    const capabilities = this.currentModelSelection().model.capabilities
    this.options.emit({
      type: 'context-usage',
      usage: {
        usedTokens: requestUsedTokens ?? this.estimateCurrentContextTokens(),
        contextWindow: capabilities.contextWindow,
        autoCompactThreshold: autoCompactThreshold(capabilities),
        breakdown,
      },
    })
  }

  private async messagesForCurrentModel(
    messages: ModelMessage[],
    abortSignal?: AbortSignal,
    includeActiveSkillContext = true,
  ): Promise<ModelMessage[]> {
    const model = this.currentModelSelection().model
    const supportsImages = model.capabilities.supportsImageInput
    const signal = abortSignal ?? new AbortController().signal
    const modelMessages = this.skillTurn.project(
      withoutMcpToolState(messages),
      includeActiveSkillContext,
    )
    const withPdfPages = supportsImages
      && this.options.pdfProcessor
      && this.options.sessionRecorder
      ? await inlineSmallPdfMessages(
          modelMessages,
          [...this.pdfAttachments.values()],
          this.options.sessionRecorder.attachmentDirectory,
          this.options.pdfProcessor,
          signal,
        )
      : modelMessages
    const withImages = await messagesForModel(
      withPdfPages,
      supportsImages,
      this.options.sessionRecorder?.attachmentDirectory,
      this.sessionImageAttachments(),
      signal,
      Boolean(this.options.auxiliaryImageAnalyzer),
    )
    return adaptMessagesForProvider(withImages, model.protocol)
  }

  private sessionImageAttachments(): ImageAttachment[] {
    return [...this.imageAttachments.values()]
  }

  private sessionPdfAttachments(): PdfAttachment[] {
    return [...this.pdfAttachments.values()].filter((attachment) =>
      this.activePdfAttachmentIds.has(attachment.id))
  }

  private pdfAttachmentById(attachmentId: string): PdfAttachment | null {
    if (!this.activePdfAttachmentIds.has(attachmentId)) return null
    for (const attachment of this.pdfAttachments.values()) {
      if (attachment.id === attachmentId) return attachment
    }
    return null
  }

  private pdfPageImage(attachmentId: string, pageNumber: number): ImageAttachment | null {
    const pdf = this.pdfAttachmentById(attachmentId)
    if (!pdf) return null
    for (const image of this.imageAttachments.values()) {
      if (
        image.source?.kind === 'pdf-page'
        && image.source.pdfAttachmentId === attachmentId
        && image.source.pdfSha256 === pdf.sha256
        && image.source.pageNumber === pageNumber
      ) return image
    }
    return null
  }

  /** 未提交的模型响应可复用已提交上下文重试，不重放工具。 */
  private async runOneStep(
    usage: UsageInfo,
    turnAbortSignal: AbortSignal,
    planExecutionEngaged: boolean,
    consumeInterruptionBoundary: boolean,
    preserveTaskPlanOnFinalText: boolean,
    subagentTurnState: SubagentTurnState | null,
  ): Promise<StepResult> {
    try {
      return await this.runModelStep(turnAbortSignal, this.options.emit, (stepAbort) =>
        this.runOneStepAttempt(
          usage, stepAbort, planExecutionEngaged, consumeInterruptionBoundary,
          preserveTaskPlanOnFinalText, subagentTurnState,
        ),
      )
    } catch (error) {
      if (error !== 'interrupt') throw error
      return {
        committed: false,
        hadToolCalls: false,
        hadOnlyTaskProgressUpdates: false,
        toolEndReason: null,
        taskPlanChanged: false,
        taskPlanEngagement: null,
        interruptionBoundaryConsumed: false,
        awaitingTaskPlanContinuation: false,
      }
    }
  }

  /** 停止与立即插话覆盖同一步的请求、退避等待和工具执行；请求超时不取消此边界。 */
  private async runModelStep<T>(
    turnSignal: AbortSignal,
    emit: (event: CoreEvent) => void,
    attempt: (abort: AbortController) => Promise<T>,
  ): Promise<T> {
    const stepAbort = new AbortController()
    const onTurnAbort = () => stepAbort.abort('user-cancel')
    turnSignal.addEventListener('abort', onTurnAbort, { once: true })
    if (turnSignal.aborted) onTurnAbort()
    this.currentStepAbort = stepAbort
    try {
      return await withModelRequestRetry(
        () => attempt(stepAbort), stepAbort.signal,
        (retry) => emit({ type: 'model-request-retry', ...retry }),
      )
    } catch (error) {
      if (stepAbort.signal.aborted) throw stepAbort.signal.reason
      throw error
    } finally {
      turnSignal.removeEventListener('abort', onTurnAbort)
      if (this.currentStepAbort === stepAbort) this.currentStepAbort = null
    }
  }

  /** 单次模型调用 + 步内工具执行；控制面工具可在成功后终止 turn。 */
  private async runOneStepAttempt(
    usage: UsageInfo,
    stepAbort: AbortController,
    planExecutionEngaged: boolean,
    consumeInterruptionBoundary: boolean,
    preserveTaskPlanOnFinalText: boolean,
    subagentTurnState: SubagentTurnState | null,
  ): Promise<StepResult> {
    if (this.options.sessionRecorder && this.persistenceFailed) {
      throw new Error('会话持久化已不可用；为避免重复执行，当前模型步骤未启动')
    }
    const { emit } = this.options

    const stepControl: {
      toolEndReason: StepResult['toolEndReason']
      taskPlanEngagement: TaskPlanEngagementAction | null
    } = {
      toolEndReason: null,
      taskPlanEngagement: null,
    }
    let userQuestion: UserQuestion | null = null
    const stepAttachments = new ToolStepAttachments(this.options.sessionRecorder, this.imageAttachments, this.pdfAttachments)
    let stepCommitted = false
    let durableTaskState = this.taskPlan?.stateSnapshot
    let toolExecution: ToolExecutionBatch | null = null
    let taskPlanFinalized = false
    let mcpStep: McpStepBinding | null = null
    this.taskPlan?.beginStep()
    try {
      mcpStep = await this.options.mcpRuntime?.beginStep(
        this.messages,
        stepAbort.signal,
      ) ?? null
      const dateReminder = currentDateReminder(this.messages, new Date())
      const subagentTurnStateMessage = subagentTurnState
        ? createSubagentTurnStateMessage(subagentTurnState)
        : null
      const modelInputMessages = [
        ...this.messages,
        ...(dateReminder ? [dateReminder] : []),
        ...(subagentTurnStateMessage ? [subagentTurnStateMessage] : []),
      ]
      const persistentInputMessageCount =
        this.messages.length + (dateReminder ? 1 : 0)
      const requestSkillProjectionDelta =
        this.skillTurn.estimatedProjectionTokenDelta(modelInputMessages)
      const requestSubagentProjectionDelta = subagentTurnStateMessage
        ? estimateMessagesTokens([subagentTurnStateMessage])
        : 0
      const requestSystemPrompt = buildSystemPrompt(
        this.options.promptContext,
        this.options.customSystemPrompt,
      )
      const requestMessages = await this.messagesForCurrentModel(
        modelInputMessages,
        stepAbort.signal,
      )
      const requestTools = this.buildToolSet(
        stepAbort.signal,
        {
          emit,
          loopHealth: this.loopHealth,
          onToolExecutionStart: (id) => toolExecution!.start(id),
          onToolExecutionEnd: (event) => toolExecution!.finish(event),
          planExecutionEngaged,
          onTaskPlanEngagement: (action) => { stepControl.taskPlanEngagement = action },
          onUserQuestion: (question) => { userQuestion = question },
          onTurnEndingTool: (reason) => { stepControl.toolEndReason = reason },
          onReadFile: (path) => this.recentReadFiles.set(path, Date.now()),
          onImageAttachments: (id, attachments, transform, limit) =>
            stepAttachments.acceptImages(id, attachments, transform, limit),
          onPdfAttachments: (id, attachments) => stepAttachments.acceptPdfs(id, attachments),
        },
        mcpStep?.toolDefinitions() ?? [],
      )
      const requestOverhead = await estimateRequestContextOverhead(
        requestSystemPrompt,
        toolsForModel(requestTools),
      )
      this.contextOverhead = requestOverhead
      const requestUsedTokens = this.tokenBaseline
        ? this.estimateCurrentContextTokens([
            ...this.messages,
            ...(dateReminder ? [dateReminder] : []),
          ])
        : requestOverhead.systemPromptTokens
          + requestOverhead.toolTokens
          + estimateMessagesTokens(requestMessages)
      this.emitContextUsage(requestMessages, requestUsedTokens)
      const result = streamText({
        maxRetries: 0,
        onError: () => {},
        model: this.createLanguageModel(),
        system: requestSystemPrompt,
        messages: requestMessages,
        tools: toolsForModel(requestTools),
        stopWhen: stepCountIs(1),
        providerOptions: this.requestProviderOptions(),
        abortSignal: stepAbort.signal,
      })

      let hadToolCalls = false
      let hadNonProgressToolCalls = false
      let thinkingStartedAt: number | null = null
      let stepTotalTokens = 0
      let finishReason: string | null = null
      const textGate = new AssistantTextGate((text) => {
        if (!this.protocolRound) emit({ type: 'text-delta', text })
      })

      for await (const part of readModelStream(result.fullStream)) {
        switch (part.type) {
          case 'reasoning-delta': {
            if (thinkingStartedAt === null) {
              thinkingStartedAt = Date.now()
              emit({ type: 'agent-status', status: 'thinking' })
            }
            emit({ type: 'thinking-delta', text: part.text })
            break
          }
          case 'reasoning-end': {
            if (thinkingStartedAt !== null) {
              emit({ type: 'thinking-end', durationMs: Date.now() - thinkingStartedAt })
              emit({ type: 'agent-status', status: 'working' })
              thinkingStartedAt = null
            }
            break
          }
          case 'text-delta':
            textGate.push(part.text)
            break
          case 'tool-call':
            if (part.providerExecuted === true) break
            hadToolCalls = true
            if (part.toolName !== UPDATE_TASK_ITEM_TOOL_NAME) hadNonProgressToolCalls = true
            break
          case 'finish':
            finishReason = part.finishReason
            usage.inputTokens += part.totalUsage.inputTokens ?? 0
            usage.outputTokens += part.totalUsage.outputTokens ?? 0
            usage.cachedInputTokens += part.totalUsage.inputTokenDetails.cacheReadTokens ?? 0
            // 本步的 input+output = 请求结束时完整上下文大小，作为计量基线
            stepTotalTokens =
              (part.totalUsage.inputTokens ?? 0) + (part.totalUsage.outputTokens ?? 0)
            break
          default:
            break
        }
      }
      textGate.finish()

      if (thinkingStartedAt !== null) {
        emit({ type: 'thinking-end', durationMs: Date.now() - thinkingStartedAt })
      }

      // 此时工具尚未执行；不完整模型响应可以丢弃，完整调用必须先写稳再派发。
      if (stepAbort.signal.aborted) throw new Error('step aborted before commit')
      const response = await result.response
      if (stepAbort.signal.aborted) throw new Error('step aborted before commit')
      const normalizedResponseMessages = normalizeResponseMessagesForProvider(
        response.messages,
        this.currentModelSelection().model.protocol,
      )
      const sanitizedResponse = sanitizeAssistantControlOutput(normalizedResponseMessages)
      const canonicalResponseMessages = sanitizedResponse.messages
      if (
        !hadToolCalls
        && (sanitizedResponse.rejected || !hasDeliverableModelText(canonicalResponseMessages))
      ) {
        throw emptyModelResponse(finishReason)
      }
      if (hadToolCalls) {
        const head = dehydrateImageMessages([
          ...(dateReminder ? [dateReminder] : []),
          ...canonicalResponseMessages,
        ])
        await this.persistRequired(
          (recorder) => recorder.recordStep(this.activeTurn!.id, head),
          '保存工具调用',
        )
        appendOrderedMessages(this.messages, head)
        toolExecution = new ToolExecutionBatch({
          messages: canonicalResponseMessages,
          abort: stepAbort,
          emit,
          recordStart: (startedToolCallId) => this.persistRequired(
            (recorder) => recorder.recordStep(this.activeTurn!.id, [], undefined, undefined, { startedToolCallId }),
            '登记工具执行',
          ),
          recordResult: async (message, event) => {
            const { messages, attachments, pdfAttachments } = stepAttachments.forTool(event.toolUseId, message)
            const taskState = this.taskPlan?.stateSnapshot
            const changedTaskState = taskState?.version !== durableTaskState?.version ? taskState : undefined
            this.assertImageAttachmentsCompatible(attachments)
            this.assertPdfAttachmentsCompatible(pdfAttachments)
            await this.persistRequired(
              (recorder) => recorder.recordStep(
                this.activeTurn!.id, messages, changedTaskState,
                changedTaskState ? changedTaskState.activePlan?.id ?? null : stepControl.taskPlanEngagement?.planId,
                { attachments, pdfAttachments },
              ),
              '保存工具结果',
            )
            appendOrderedMessages(this.messages, messages)
            this.addImageAttachments(attachments)
            this.addPdfAttachments(pdfAttachments)
            durableTaskState = taskState
          },
        })
        await toolExecution.run(requestTools)
        if (stepAbort.signal.aborted) stepControl.toolEndReason = null
      }
      let awaitingTaskPlanContinuation = false
      let taskPlanClosedNaturally = false
      if (
        !hadToolCalls
        && planExecutionEngaged
        && !preserveTaskPlanOnFinalText
        && !this.hasPendingMessages()
      ) {
        const activePlan = this.taskPlan?.snapshot
        if (activePlan) {
          awaitingTaskPlanContinuation = this.taskPlan!.hasUnfinishedWork()
            && Boolean(this.options.hasPendingTaskPlanContinuation?.(activePlan.id))
          if (!awaitingTaskPlanContinuation) {
            const finalized = this.taskPlan!.finishNaturalRun()
            if (!finalized.ok) throw new Error(finalized.message)
            taskPlanClosedNaturally = true
          }
        }
      }
      const taskPlanCommit = this.taskPlan?.commitStep()
      const naturallyClosedTaskState = taskPlanClosedNaturally
        ? taskPlanCommit?.state
        : undefined
      if (taskPlanClosedNaturally && !naturallyClosedTaskState) {
        throw new Error('自然结束任务计划后未生成状态提交')
      }
      taskPlanFinalized = Boolean(this.taskPlan)
      const planRemainsActive = Boolean(
        taskPlanCommit ? taskPlanCommit.state.activePlan : this.taskPlan?.snapshot,
      )
      const questionResumesTaskPlan = userQuestion !== null
        && stepControl.toolEndReason === 'waiting-user'
        && planRemainsActive
        && (
          planExecutionEngaged
          || stepControl.taskPlanEngagement?.type === 'resume'
          || taskPlanCommit !== undefined
        )
      const internalMarkers: ModelMessage[] = []
      if (naturallyClosedTaskState) {
        internalMarkers.push(createTaskStateMessage(naturallyClosedTaskState))
      }
      if (consumeInterruptionBoundary) {
        internalMarkers.push(createTurnAbortedConsumedMessage())
      }
      if (userQuestion && stepControl.toolEndReason === 'waiting-user') {
        internalMarkers.push(createUserQuestionMarker(
          userQuestion,
          questionResumesTaskPlan,
        ))
      }
      const mcpCommitMessages = mcpStep?.messagesOnCommit() ?? []
      const committedMessages = dehydrateImageMessages([
        ...(!toolExecution && dateReminder ? [dateReminder] : []),
        ...(!toolExecution ? canonicalResponseMessages : []),
        ...stepAttachments.pdfReferences(),
        ...internalMarkers,
        ...mcpCommitMessages,
      ])
      const engagementUpdate = taskPlanCommit
        ? taskPlanCommit.state.activePlan?.id ?? null
        : stepControl.taskPlanEngagement?.planId
      await this.persistRequired(
        (recorder) => recorder.recordStep(
          this.activeTurn!.id,
          committedMessages,
          taskPlanCommit?.state,
          engagementUpdate,
        ),
        '提交模型步骤',
      )
      stepCommitted = true
      this.messages.push(...committedMessages)
      if (userQuestion && stepControl.toolEndReason === 'waiting-user') {
        emit({ type: 'user-question', question: userQuestion })
      }
      if (taskPlanCommit) {
        emit({ type: 'task-plan-updated', plan: taskPlanCommit.plan })
      }
      if (stepTotalTokens > 0) {
        const responseCoveredCount = canonicalResponseMessages.findIndex((message) =>
          message.role !== 'assistant')
        this.tokenBaseline = {
          usageTokens: stepTotalTokens,
          // usage 覆盖模型输入（含本步日期提醒）和 assistant 输出，
          // 不含宿主随后追加的 tool result、页面图和控制标记。
          coveredMessageCount:
            persistentInputMessageCount
            + (responseCoveredCount < 0
              ? canonicalResponseMessages.length
              : responseCoveredCount),
        }
        this.tokenBaselineSkillProjectionDelta = requestSkillProjectionDelta
        this.tokenBaselineSubagentProjectionDelta = requestSubagentProjectionDelta
      }
      this.updateLastTurnAssistantText(canonicalResponseMessages)
      emit({ type: 'step-committed' })
      this.lastFinishReason = finishReason
      this.emitContextUsage()
      return {
        committed: true,
        hadToolCalls,
        hadOnlyTaskProgressUpdates: hadToolCalls && !hadNonProgressToolCalls,
        toolEndReason: stepControl.toolEndReason,
        taskPlanChanged: taskPlanCommit !== undefined,
        taskPlanEngagement: stepControl.taskPlanEngagement,
        interruptionBoundaryConsumed: consumeInterruptionBoundary,
        awaitingTaskPlanContinuation,
      }
    } catch (error) {
      mcpStep?.discard()
      await stepAttachments.discardUncommitted()
      if (!stepCommitted && durableTaskState && (taskPlanFinalized || toolExecution)) {
        this.taskPlan?.restore(durableTaskState)
      } else {
        this.taskPlan?.discardStep()
      }
      if (!toolExecution && stepAbort.signal.aborted && stepAbort.signal.reason === 'user-cancel') {
        emit({ type: 'step-output-retained' })
      }
      emit({ type: toolExecution ? 'step-committed' : 'step-discarded' })
      throw error
    }
  }

  /** 包装当前角色可用的完整工具集；权限档位只在调用边界判定，不改变模型工具目录。 */
  private buildToolSet(
    abortSignal: AbortSignal,
    context: ToolStepContext,
    mcpTools: readonly ToolDefinition[],
  ): StepToolSet | undefined {
    const model = this.currentModelSelection().model
    const extraTools = this.options.extraTools ?? []
    const taskTools = this.taskPlan
      && !this.options.promptContext.discussion
      && !this.protocolRound
      ? createTaskPlanTools(this.taskPlan, {
          onEngagementAction: (action) => context.onTaskPlanEngagement?.(action),
          isEngaged: () => context.planExecutionEngaged === true,
        })
      : []
    const questionTools: ToolDefinition[] =
      this.userQuestionsEnabled
      && !this.options.promptContext.discussion
      && !this.protocolRound
        ? [
            createAskUserQuestionTool((question) => context.onUserQuestion?.(question)),
          ]
        : []
    const mainTools = !this.options.promptContext.discussion
      && !this.protocolRound
      ? [...(this.options.mainTools ?? []), ...mcpTools]
      : []
    const skillCatalog = this.skillTurn.catalogSnapshot
    const skillTools: ToolDefinition[] = skillCatalog
      && skillCatalog.entries.length > 0
      && !this.options.promptContext.discussion
      && !this.protocolRound
      ? [createSkillTool(skillCatalog)]
      : []
    const controlTools: ToolDefinition[] = [
      ...extraTools,
      ...taskTools,
      ...questionTools,
      ...skillTools,
      ...mainTools,
    ]
    const imageTools: ToolDefinition[] =
      model.capabilities.supportsImageInput
      && this.options.sessionRecorder
      && !this.options.promptContext.discussion
      && !this.protocolRound
        ? [
            createViewImageTool({
              attachmentDirectory: this.options.sessionRecorder.attachmentDirectory,
              sessionId: this.options.sessionRecorder.sessionId,
              supportsOriginalDetail:
                model.capabilities.supportsOriginalImageDetail === true,
            }),
            ...(this.options.captureScreenshot
              ? [createCaptureScreenshotTool({
                  attachmentDirectory: this.options.sessionRecorder.attachmentDirectory,
                  sessionId: this.options.sessionRecorder.sessionId,
                  capture: this.options.captureScreenshot,
                  supportsOriginalDetail:
                    model.capabilities.supportsOriginalImageDetail === true,
                })]
              : []),
          ]
        : []
    const auxiliaryImageTools = this.buildAuxiliaryImageTools()
    const pdfTools: ToolDefinition[] =
      this.options.pdfProcessor
      && this.options.sessionRecorder
      && !this.options.promptContext.discussion
      && !this.protocolRound
        ? [createReadPdfTool({
            attachmentDirectory: this.options.sessionRecorder.attachmentDirectory,
            sessionId: this.options.sessionRecorder.sessionId,
            processor: this.options.pdfProcessor,
            supportsVisual: model.capabilities.supportsImageInput,
            resolveAttachment: (attachmentId) => {
              const attachment = this.pdfAttachmentById(attachmentId)
              return attachment
                ? {
                    attachment,
                    path: pdfAttachmentPath(
                      this.options.sessionRecorder!.attachmentDirectory,
                      attachment.storageName,
                    ),
                  }
                : null
            },
            resolvePageImage: (attachmentId, pageNumber) =>
              this.pdfPageImage(attachmentId, pageNumber),
          })]
        : []
    const officeVisualTools: ToolDefinition[] =
      this.options.officeProcessor
      && model.capabilities.supportsImageInput
      && this.options.sessionRecorder
      && !this.options.promptContext.discussion
      && !this.protocolRound
        ? [createRenderOfficeTool({
            attachmentDirectory: this.options.sessionRecorder.attachmentDirectory,
            sessionId: this.options.sessionRecorder.sessionId,
            processor: this.options.officeProcessor,
          })]
        : []
    const defs: ToolDefinition[] = [
      ...(this.options.baseTools ?? BUILTIN_TOOLS),
      ...imageTools,
      ...auxiliaryImageTools,
      ...pdfTools,
      ...officeVisualTools,
      ...controlTools,
    ]
    const subagentTools = this.options.promptContext.subagent?.toolNames
    const availableDefs = subagentTools
      ? defs.filter((def) => subagentTools.includes(def.name) || taskTools.includes(def))
      : defs
    return this.wrapToolDefinitions(availableDefs, abortSignal, context)
  }

  private wrapToolDefinitions(
    defs: readonly ToolDefinition[],
    abortSignal: AbortSignal,
    context: ToolStepContext,
  ): StepToolSet | undefined {
    const { emit, loopHealth, planExecutionEngaged, allowedToolNames } = context
    const model = this.currentModelSelection().model
    const toolProjectDir = this.options.promptContext.projectDir
    if (defs.length === 0) return undefined
    const approvalBatcher = new StepToolApprovalBatcher({
      permissions: () => this.permissions,
      setStatus: (status) => emit({ type: 'agent-status', status }),
      requestApproval: this.options.requestApproval,
      applySuggestion: (suggestion) => this.applySuggestion(suggestion),
    })
    const toolSet: StepToolSet = {}
    let firstStepToolName: string | null = null
    let standaloneStepToolName: string | null = null
    const claimStepTool = (def: ToolDefinition): string | null => {
      if (standaloneStepToolName) {
        return `${standaloneStepToolName} 必须独占一个模型步骤；请在下一模型步骤再调用 ${def.name}。`
      }
      if (def.requiresStandaloneStep && firstStepToolName) {
        return `${def.name} 必须独占一个模型步骤，但本步骤已经调用 ${firstStepToolName}；请在下一模型步骤单独调用 ${def.name}。`
      }
      firstStepToolName ??= def.name
      if (def.requiresStandaloneStep) standaloneStepToolName = def.name
      return null
    }
    for (const def of defs) {
      const finishTool = (toolCallId: string, result: string, isError: boolean, fileChanges?: ToolFileChange[]): Promise<string> => {
        const event: ToolEndEvent = {
          type: 'tool-end', toolUseId: toolCallId, result, isError,
          ...(fileChanges?.length ? { fileChanges } : {}),
        }
        if (context.onToolExecutionEnd) return context.onToolExecutionEnd(event)
        emit(event)
        return Promise.resolve(result)
      }
      const prepareTool = async (
        input: unknown,
        toolCallId: string,
      ): Promise<() => Promise<string>> => {
        if (abortSignal.aborted) return () => finishTool(toolCallId, TOOL_NOT_STARTED, true)
        // additionalDirs 会在审批中变化，每次调用取最新
        let toolCtx: ToolContext = {
          workspaceIO: this.options.workspaceIO,
          projectDir: toolProjectDir,
          additionalDirs: this.permissions.additionalDirs,
          abortSignal,
          ...(this.activeTurn ? { turnId: this.activeTurn.id } : {}),
          toolCallId,
          ...(planExecutionEngaged && this.taskPlan?.snapshot
            ? { engagedPlanId: this.taskPlan.snapshot.id }
            : {}),
        }
        const parsed = await validateToolInput(def, input)
        if (!parsed.success) {
          const msg = `参数校验失败：${parsed.error.message}`
          loopHealth.record(def.name, input, msg, true)
          return () => finishTool(toolCallId, msg, true)
        }

        // 审批只准备当前精确输入，批准先后不能改变批次调度器保留的调用顺序。
        const authorization = await approvalBatcher.authorize(
          def,
          parsed.value,
          toolCtx,
          toolCallId,
        )
        if (!authorization.approved) {
          const msg = abortSignal.aborted ? `${TOOL_NOT_STARTED}\n${authorization.message}` : authorization.message
          loopHealth.record(def.name, parsed.value, msg, true)
          return () => finishTool(toolCallId, msg, true)
        }
        if (authorization.approvedPaths.length > 0) {
          // 用户批准的是这组完整输入：路径只扩展当前调用，是否持久化仍由 remember 决定。
          toolCtx = {
            ...toolCtx,
            additionalDirs: [
              ...toolCtx.additionalDirs,
              ...authorization.approvedPaths.map((path) =>
                (this.options.workspaceIO ?? localWorkspaceIO).path.resolve(toolProjectDir, path),
              ),
            ],
          }
        }

        const executeAuthorized = async (): Promise<string> => {
          if (abortSignal.aborted) {
            const msg = TOOL_NOT_STARTED
            loopHealth.record(def.name, parsed.value, msg, true)
            return finishTool(toolCallId, msg, true)
          }
          // 批准与真正开始执行之间仍可能切档；只重查不可被批准覆盖的硬拒绝。
          const currentPermission = await checkToolPermission(def, parsed.value, this.permissions)
          if (currentPermission.behavior === 'deny') {
            const msg = `操作被拒绝：${currentPermission.reason}`
            loopHealth.record(def.name, parsed.value, msg, true)
            return finishTool(toolCallId, msg, true)
          }

          // 只有工具显式声明资源边界才建立检查点；权限路径不能替代回滚覆盖契约。
          let preparedCheckpoint: Awaited<ReturnType<CheckpointManager['prepare']>> = null
          if (
            (def.kind === 'edit' || def.kind === 'execute') &&
            this.checkpoints &&
            this.activeTurn &&
            !this.permissions.discussion
          ) {
            const turnId = this.activeTurn.id
            if (!def.checkpointScope) {
              await this.checkpoints
                .recordBarrier(toolCallId, turnId, `${def.name} 未声明可回滚资源范围`)
                .catch(() => {})
            } else {
              try {
                const checkpointScope = await def.checkpointScope(parsed.value, toolCtx)
                preparedCheckpoint = await this.checkpoints.prepare(
                  toolCallId,
                  turnId,
                  checkpointScope,
                )
                if (!preparedCheckpoint) {
                  const reason = this.checkpoints.disabled ?? `${def.name} 未建立检查点`
                  await this.checkpoints.recordBarrier(
                    toolCallId,
                    turnId,
                    reason,
                  )
                  if (!this.checkpointDisabledNotified) {
                    this.checkpointDisabledNotified = true
                    emit({ type: 'checkpoint-disabled', reason })
                  }
                }
              } catch (error) {
                const reason = error instanceof Error ? error.message : String(error)
                await this.checkpoints.recordBarrier(toolCallId, turnId, reason).catch(() => {})
                if (!this.checkpointDisabledNotified) {
                  this.checkpointDisabledNotified = true
                  emit({ type: 'checkpoint-disabled', reason })
                }
              }
            }
          }

          const finalizeCheckpoint = async (): Promise<void> => {
            if (!preparedCheckpoint || !this.checkpoints) return
            const ready = await this.checkpoints.finalize(preparedCheckpoint)
            if (ready) {
              emit({
                type: 'checkpoint-created',
                toolUseId: toolCallId,
                hash: ready.id,
                coverage: 'complete',
              })
              const turn = this.activeTurn
              if (turn?.id === ready.turnId) {
                try {
                  for (const [path, change] of await this.checkpoints.turnFileChanges(ready)) {
                    if (change) turn.fileChanges.set(path, change)
                    else turn.fileChanges.delete(path)
                  }
                } catch {
                  // 统计不可用不能撤销已完成的写入，也不能继续展示过期的精确数字。
                  turn.fileChanges.clear()
                }
                emit({ type: 'turn-file-changes', changes: this.turnFileChanges })
              }
            } else if (this.checkpoints.disabled && !this.checkpointDisabledNotified) {
              this.checkpointDisabledNotified = true
              emit({ type: 'checkpoint-disabled', reason: this.checkpoints.disabled })
            }
          }

          if (abortSignal.aborted) return finishTool(toolCallId, TOOL_NOT_STARTED, true)
          await context.onToolExecutionStart?.(toolCallId)
          if (abortSignal.aborted) return finishTool(toolCallId, TOOL_NOT_STARTED, true)
          try {
            let result = await def.execute(parsed.value, {
              ...toolCtx,
              onProgress: (output) =>
                emit({ type: 'tool-progress', toolUseId: toolCallId, output }),
            })
            if (result.pdfAttachments?.length) {
              const error = context.onPdfAttachments
                ? await context.onPdfAttachments(toolCallId, result.pdfAttachments)
                : '当前工具步骤无法接收 PDF 附件'
              if (error) result = { data: error, isError: true }
            }
            let viewedAttachments: readonly ImageAttachment[] = []
            if (result.attachments?.length) {
              const error = context.onImageAttachments
                ? await context.onImageAttachments(
                  toolCallId,
                  result.attachments,
                  result.imageTransform,
                  def.name === READ_PDF_TOOL_NAME
                    ? PDF_VISUAL_MAX_PAGES
                    : TOOL_IMAGE_ATTACHMENT_MAX_COUNT,
                )
                : '当前工具步骤无法接收图片附件'
              if (error) result = { data: error, isError: true }
              else if (!result.isError && def.name !== READ_PDF_TOOL_NAME) {
                viewedAttachments = result.attachments
              }
            }
            // 记录读过的文件（压缩后重注入，防失忆）
            if (def.name === READ_FILE_TOOL_NAME && !result.isError) {
              try {
                const abs = await resolveAllowed(toolCtx, (parsed.value as { path: string }).path)
                context.onReadFile?.(abs)
              } catch {
                /* 越界读取已被权限层处理，这里忽略 */
              }
            }
            await finalizeCheckpoint()
            if (viewedAttachments.length > 0) {
              emit({
                type: 'image-viewed',
                toolUseId: toolCallId,
                attachments: [...viewedAttachments],
              })
            }
            if (def.name === SKILL_TOOL_NAME) {
              this.skillTurn.recordToolResult(toolCallId, parsed.value, !result.isError)
            }
            if (def.endsTurnOnSuccess && !result.isError) {
              context.onTurnEndingTool?.(def.turnEndReasonOnSuccess)
            }
            loopHealth.record(def.name, parsed.value, result.data, result.isError)
            return finishTool(toolCallId, result.data, result.isError, result.fileChanges ? [...result.fileChanges] : undefined)
          } catch (error) {
            await finalizeCheckpoint()
            const msg = `工具执行出错：${error instanceof Error ? error.message : String(error)}`
            if (def.name === SKILL_TOOL_NAME) {
              this.skillTurn.recordToolResult(toolCallId, parsed.value, false)
            }
            loopHealth.record(def.name, parsed.value, msg, true)
            return finishTool(toolCallId, msg, true)
          }
        }

        return () => (def.kind === 'edit' || def.kind === 'execute') && this.options.scheduleProjectMutation
          ? this.options.scheduleProjectMutation(
              { type: 'tool', name: def.name, kind: def.kind }, abortSignal, executeAuthorized,
            )
          : executeAuthorized()
      }
      const prepareWithStepGate = async (
        input: unknown,
        toolCallId: string,
      ): Promise<() => Promise<string>> => {
        const deniedByMode = allowedToolNames && !allowedToolNames.has(def.name)
        const conflict = deniedByMode
          ? `临时对话不允许使用 ${def.name}，未执行。请使用允许的只读工具或依据已有上下文回答。`
          : claimStepTool(def)
        if (conflict) {
          loopHealth.record(def.name, input, conflict, true)
          return () => finishTool(toolCallId, conflict, true)
        }
        return prepareTool(input, toolCallId)
      }
      toolSet[def.name] = {
        isReadOnly: def.isReadOnly,
        prepare: prepareWithStepGate,
        definition: aiTool({
          description: def.prompt,
          inputSchema: def.inputSchema,
          // Responses 默认 strict 会补造可选参数；运行时 schema 才是输入权威。
          ...(model.protocol === 'openai-responses' ? { strict: false } : {}),
        }),
      }
    }
    return toolSet
  }

  private buildAuxiliaryImageTools(): ToolDefinition[] {
    const analyzer = this.options.auxiliaryImageAnalyzer
    const recorder = this.options.sessionRecorder
    const model = this.currentModelSelection().model
    if (
      model.capabilities.supportsImageInput
      || !analyzer
      || !recorder
      || this.options.promptContext.discussion
      || this.protocolRound
    ) return []

    const attachments = this.sessionImageAttachments()
    const activeIds = referencedImageAttachmentIds(this.messages, attachments)
    const activeAttachments = new Map(
      attachments
        .filter((attachment) => activeIds.has(attachment.id.toLowerCase()))
        .map((attachment) => [attachment.id.toLowerCase(), attachment]),
    )
    return [createAnalyzeImageTool({
      analyzer,
      attachmentDirectory: recorder.attachmentDirectory,
      resolveAttachment: (attachmentId) =>
        activeAttachments.get(attachmentId.toLowerCase()) ?? null,
    })]
  }

  /** 二次确认前只读校验恢复范围；实际执行仍会重新检查，避免确认期间状态变化。 */
  async checkCheckpointRestore(
    toolUseId: string,
    scope: 'files' | 'files-and-chat',
  ): Promise<RestoreCheckpointResult> {
    if (!this.checkpoints) return { ok: false, error: '该操作没有可用快照' }
    if (this.running || this.compacting || this.editingTurn) {
      return { ok: false, error: 'Agent 工作中，请先停止' }
    }
    if (this.restoringCheckpointToolUseId) {
      return { ok: false, error: '已有回滚操作正在进行，请等待完成' }
    }
    const record = await this.checkpoints.getReady(toolUseId)
    if (!record) return { ok: false, error: '该操作没有可用快照' }
    if (scope === 'files-and-chat') {
      const recorder = this.options.sessionRecorder
      if (
        recorder?.messagesBeforeTurn(record.turnId) === null
        || recorder?.taskStateBeforeTurn(record.turnId) === undefined
      ) {
        return {
          ok: false,
          turnId: record.turnId,
          error: '该轮早于上下文压缩或当前活动历史，只能回滚文件（选「仅文件」）',
        }
      }
    }
    return this.checkpoints.checkRestore(toolUseId, scope)
  }

  /** 回滚到某写操作执行前（仅空闲时）；files-and-chat = 整个 turn「从没发生过」 */
  async restoreCheckpoint(
    toolUseId: string,
    scope: 'files' | 'files-and-chat',
  ): Promise<void> {
    if (!this.checkpoints) {
      this.emitCheckpointRestored({
        type: 'checkpoint-restored', toolUseId, turnId: '', scope, ok: false,
        error: '该操作没有可用快照',
      })
      return
    }
    if (this.running || this.compacting || this.editingTurn) {
      this.emitCheckpointRestored({
        type: 'checkpoint-restored', toolUseId, turnId: '', scope, ok: false,
        error: 'Agent 工作中，请先停止',
      })
      return
    }
    // Renderer 会立即禁用按钮；这里仍做核心层单飞，防 IPC 重复提交或其它宿主并发调用。
    if (this.restoringCheckpointToolUseId) return
    this.restoringCheckpointToolUseId = toolUseId
    try {
      const operation = () => this.restoreCheckpointUnshared(toolUseId, scope)
      if (this.options.scheduleProjectMutation) {
        await this.options.scheduleProjectMutation(
          { type: 'checkpoint-restore', toolUseId },
          new AbortController().signal,
          operation,
        )
      } else {
        await operation()
      }
    } finally {
      this.restoringCheckpointToolUseId = null
      if (
        this.hasPendingMessages()
        && (this.queue.length > 0 || !findPendingUserQuestion(this.messages))
      ) {
        await this.startPendingTurn()
      }
      this.resolveIdleWaiters()
    }
  }

  private async restoreCheckpointUnshared(
    toolUseId: string,
    scope: 'files' | 'files-and-chat',
  ): Promise<void> {
    const record = await this.checkpoints!.getReady(toolUseId)
    if (!record) {
      this.emitCheckpointRestored({
        type: 'checkpoint-restored', toolUseId, turnId: '', scope, ok: false,
        error: '该操作没有可用快照',
      })
      return
    }
    const recorder = this.options.sessionRecorder
    const rollbackMessages = scope === 'files-and-chat'
      ? recorder?.messagesBeforeTurn(record.turnId) ?? null
      : null
    const rollbackTaskState = scope === 'files-and-chat'
      ? recorder?.taskStateBeforeTurn(record.turnId)
      : undefined
    if (
      scope === 'files-and-chat'
      && (rollbackMessages === null || rollbackTaskState === undefined)
    ) {
      this.emitCheckpointRestored({
        type: 'checkpoint-restored',
        toolUseId,
        turnId: record.turnId,
        scope,
        ok: false,
        error: '该轮早于上下文压缩或当前活动历史，只能回滚文件（选「仅文件」）',
      })
      return
    }
    const originalMessages = structuredClone(this.messages)
    const originalTaskState = this.taskPlan?.stateSnapshot
    const rollbackQuestion = rollbackMessages === null
      ? undefined
      : findPendingUserQuestion(rollbackMessages)?.question ?? null
    const result = await this.checkpoints!.restore(
      toolUseId,
      scope,
      rollbackMessages !== null && recorder ? {
        commit: async () => {
          await recorder.recordSnapshot('rollback', rollbackMessages, undefined, rollbackTaskState)
          this.messages = structuredClone(rollbackMessages)
          this.rebuildActivePdfAttachments()
          this.taskPlan?.restore(rollbackTaskState!)
          this.tokenBaseline = null
        },
        compensate: async () => {
          await recorder.recordSnapshot('rollback', originalMessages, undefined, originalTaskState)
          this.messages = structuredClone(originalMessages)
          this.rebuildActivePdfAttachments()
          if (originalTaskState) this.taskPlan?.restore(originalTaskState)
          this.tokenBaseline = null
        },
      } : undefined,
    )
    this.emitCheckpointRestored({
      type: 'checkpoint-restored',
      toolUseId,
      turnId: result.turnId ?? record.turnId,
      scope,
      ok: result.ok,
      error: result.error,
      invalidatedToolUseIds: result.invalidatedToolUseIds,
      ...(result.ok && scope === 'files-and-chat'
        ? { taskPlan: rollbackTaskState?.activePlan ?? null, question: rollbackQuestion ?? null }
        : {}),
    })
    if (result.ok && scope === 'files-and-chat') this.emitContextUsage()
  }

  private emitCheckpointRestored(
    event: Extract<CoreEvent, { type: 'checkpoint-restored' }>,
  ): void {
    this.restoringCheckpointToolUseId = null
    this.options.emit(event)
  }

  private addImageAttachments(values: readonly ImageAttachment[]): void {
    this.assertImageAttachmentsCompatible(values)
    for (const value of values) {
      const attachment = imageAttachmentSchema.parse(value)
      this.imageAttachments.set(attachment.storageName, attachment)
    }
  }

  private assertImageAttachmentsCompatible(values: readonly ImageAttachment[]): void {
    for (const value of values) {
      const attachment = imageAttachmentSchema.parse(value)
      if (
        this.options.sessionRecorder
        && attachment.sessionId !== this.options.sessionRecorder.sessionId
      ) {
        throw new Error('图片附件不属于当前会话')
      }
      const previous = this.imageAttachments.get(attachment.storageName)
      if (previous && JSON.stringify(previous) !== JSON.stringify(attachment)) {
        throw new Error(`同一图片附件存在冲突元数据：${attachment.storageName}`)
      }
    }
  }

  private addPdfAttachments(values: readonly PdfAttachment[]): void {
    this.assertPdfAttachmentsCompatible(values)
    for (const value of values) {
      const attachment = pdfAttachmentSchema.parse(value)
      this.pdfAttachments.set(attachment.storageName, attachment)
      this.activePdfAttachmentIds.add(attachment.id)
    }
  }

  private assertPdfAttachmentsCompatible(values: readonly PdfAttachment[]): void {
    for (const value of values) {
      const attachment = pdfAttachmentSchema.parse(value)
      if (
        this.options.sessionRecorder
        && attachment.sessionId !== this.options.sessionRecorder.sessionId
      ) {
        throw new Error('PDF 附件不属于当前会话')
      }
      const previous = this.pdfAttachments.get(attachment.storageName)
      if (previous && JSON.stringify(previous) !== JSON.stringify(attachment)) {
        throw new Error(`同一 PDF 附件存在冲突元数据：${attachment.storageName}`)
      }
    }
  }

  private rebuildActivePdfAttachments(): void {
    const referencedIds = referencedPdfAttachmentIds(this.messages)
    const queuedIds = new Set(this.queue.flatMap((item) =>
      item.pdfAttachments.map((attachment) => attachment.id)))
    this.activePdfAttachmentIds = new Set(
      [...this.pdfAttachments.values()].flatMap((attachment) =>
        referencedIds.has(attachment.id) || queuedIds.has(attachment.id)
          ? [attachment.id]
          : []),
    )
  }

  private async resolveProjectInstructions(): Promise<{
    update: ProjectInstructionsUpdate | null
    message: ModelMessage | null
  }> {
    const snapshot = await loadProjectInstructions({
      workspaceIO: this.options.workspaceIO,
      homeDir: this.options.promptContext.homeDir,
      projectDir: this.options.promptContext.projectDir,
    })
    const update = projectInstructionsUpdate(this.messages, snapshot)
    return {
      update,
      message: update
        ? update.message
        : findProjectInstructionsMessage(this.messages),
    }
  }

  private applyResolvedProjectInstructions(message: ModelMessage | null): void {
    const next = applyProjectInstructions(this.messages, message)
    const changed = next.length !== this.messages.length
      || next.some((entry, index) => entry !== this.messages[index])
    if (!changed) return
    this.messages = next
    this.rebuildActivePdfAttachments()
    this.tokenBaseline = null
    this.emitContextUsage()
  }

  private async refreshProjectInstructions(): Promise<void> {
    const resolved = await this.resolveProjectInstructions()
    if (resolved.update) {
      await this.persistRequired(
        (recorder) => recorder.recordProjectInstructions(resolved.update!),
        '提交项目指令',
      )
    }
    this.applyResolvedProjectInstructions(resolved.message)
  }

  /** 采纳审批建议（本会话内生效，不落盘） */
  private applySuggestion(suggestion: ApprovalSuggestion): void {
    if (suggestion.kind === 'add-dir') {
      if (!this.permissions.additionalDirs.includes(suggestion.dir)) {
        this.permissions.additionalDirs.push(suggestion.dir)
      }
    } else if (!this.permissions.sessionAllowedTools.includes(suggestion.toolName)) {
      this.permissions.sessionAllowedTools.push(suggestion.toolName)
    }
  }

  /** 持久化是可靠性增强而非 Agent 可用性的单点：失败一次后明确告警并降级内存模式 */
  private async persist(action: (recorder: SessionRecorder) => Promise<void>): Promise<void> {
    const recorder = this.options.sessionRecorder
    if (!recorder || this.persistenceFailed) return
    try {
      await action(recorder)
    } catch (error) {
      this.persistenceFailed = true
      this.options.emit({
        type: 'error',
        message: `会话持久化失败，已降级为内存模式：${error instanceof Error ? error.message : String(error)}`,
        recoverable: true,
      })
    }
  }

  /** 用户输入送达与稳定 step 不能降级成内存提交，否则崩溃后会重复执行。 */
  private async persistRequired(
    action: (recorder: SessionRecorder) => Promise<void>,
    boundary: string,
  ): Promise<void> {
    const recorder = this.options.sessionRecorder
    if (!recorder) return
    if (this.persistenceFailed) {
      throw new Error(`会话持久化已不可用，无法安全${boundary}`)
    }
    try {
      await action(recorder)
    } catch (error) {
      this.persistenceFailed = true
      throw new Error(
        `会话持久化失败，已停止${boundary}以避免重复执行：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }
}


function hasDeliverableModelText(messages: ModelMessage[]): boolean {
  const text = messages.map(modelMessageText).join('\n').trim()
  if (!text) return false

  // Antigravity 等工具协议偶尔会作为普通文本泄漏。整条响应只有协议封装时，
  // 它既不是结构化工具调用，也不是面向用户的答复，不能作为自然完成提交。
  return !/^out:default_api:[A-Za-z_][A-Za-z0-9_.-]*\s*\{[\s\S]*\}$/u.test(text)
}
