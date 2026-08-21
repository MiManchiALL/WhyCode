import {
  AgentSession,
  BUILTIN_TOOLS,
  type AuxiliaryImageAnalyzer,
  type CoreEvent,
  type ModelEntry,
  type ProviderConfig,
  type SessionJournal,
  type SkillCatalogService,
  type SubagentManifest,
  type ToolDefinition,
} from '@whycode/core'
import type { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import type { HostOperationScheduler } from './host-operation-scheduler.ts'
import type { SessionScratchManager } from './session-scratch.ts'

export interface ResolvedSubagentModel {
  entry: ModelEntry
  providerConfig: ProviderConfig
}

interface SubagentSessionFactoryOptions {
  parentRuntime: DesktopSessionRuntime
  projectDir: string
  manifest: SubagentManifest
  journal: SessionJournal
  scratch: SessionScratchManager
  skills: SkillCatalogService
  webSearchTool: ToolDefinition
  createWebPageTools: (journal: SessionJournal) => ToolDefinition[]
  resolveModel: (modelId: string) => ResolvedSubagentModel | null
  auxiliaryImageAnalyzer: () => AuxiliaryImageAnalyzer | undefined
  hostOperations: HostOperationScheduler
  emit: (event: CoreEvent) => void
}

/** 用冻结定义装配一次冷激活；父工具、MCP、提问和后台命令不会进入工具集。 */
export async function createSubagentAgentSession(
  options: SubagentSessionFactoryOptions,
): Promise<AgentSession> {
  const resolved = options.resolveModel(options.manifest.modelId)
  if (!resolved) throw new Error(`子代理模型连接不可用：${options.manifest.modelId}`)
  const scratch = await options.scratch.ensureSubagent(
    options.manifest.parentSessionId,
    options.manifest.id,
  )
  const parentPermission = options.parentRuntime.session?.permissionSnapshot
  if (!parentPermission) throw new Error('父会话权限上下文已释放')
  const allowedTools = new Set(options.manifest.definition.toolNames)
  const baseTools = (BUILTIN_TOOLS as readonly ToolDefinition[])
    .filter((tool) => allowedTools.has(tool.name))
  const mainTools = [
    ...(allowedTools.has(options.webSearchTool.name) ? [options.webSearchTool] : []),
    ...options.createWebPageTools(options.journal)
      .filter((tool) => allowedTools.has(tool.name)),
  ]
  return new AgentSession({
    model: resolved.entry,
    providerConfig: resolved.providerConfig,
    reasoningEffort: options.manifest.reasoningEffort,
    promptContext: {
      projectDir: options.projectDir,
      osPlatform: process.platform,
      scratch: {
        rootDir: scratch.subagentDirectory,
        workingDir: scratch.subagentDirectory,
      },
      subagent: {
        id: options.manifest.id,
        name: options.manifest.definition.name,
        description: options.manifest.definition.description,
        instructions: options.manifest.definition.instructions,
        toolNames: [...options.manifest.definition.toolNames],
      },
    },
    baseTools,
    mainTools,
    skillCatalog: options.skills,
    sessionRecorder: options.journal,
    auxiliaryImageAnalyzer: allowedTools.has('ViewImage')
      ? options.auxiliaryImageAnalyzer()
      : undefined,
    initialPermission: {
      mode: options.parentRuntime.permissionMode,
      additionalDirs: [...new Set([
        ...options.manifest.permission.additionalDirs,
        ...parentPermission.additionalDirs,
      ])],
      sessionAllowedTools: [...new Set([
        ...options.manifest.permission.sessionAllowedTools,
        ...parentPermission.sessionAllowedTools,
      ])],
    },
    userQuestionsEnabled: false,
    scheduleProjectMutation: (_mutation, abortSignal, operation) =>
      options.hostOperations.runProjectWrite(options.projectDir, abortSignal, operation),
    emit: options.emit,
    requestApproval: (request) => options.parentRuntime.requestApproval(request),
  })
}
