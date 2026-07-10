export type {
  CoreEvent,
  CoreCommand,
  CoreEventSink,
  UsageInfo,
  AgentStatus,
  StopReason,
} from './events.ts'
export {
  MODEL_REGISTRY,
  getModelEntry,
  type ModelEntry,
  type ModelCapabilities,
  type ProviderConfig,
} from './providers/registry.ts'
export {
  buildTool,
  type ToolDefinition,
  type ToolContext,
  type ToolCheckpointScope,
  type ToolResult,
} from './tools/tool.ts'
export {
  AgentSession,
  type AgentSessionOptions,
  type ApprovalHandler,
  type ApprovalRequest,
  type ApprovalResponse,
} from './agent/session.ts'
export { buildSystemPrompt, type PromptContext } from './prompts/system.ts'
export { BUILTIN_TOOLS } from './tools/registry.ts'
export {
  PERMISSION_MODES,
  type PermissionMode,
  type ApprovalSuggestion,
} from './permissions/types.ts'
export {
  PeerAgent,
  type PeerAgentOptions,
} from './consensus/peer-agent.ts'
export { runProtocolRound, type RoundResult } from './consensus/run-round.ts'
export {
  runFullConsensus,
  passesRound1,
  countRound2Votes,
  round3Winner,
} from './consensus/full-consensus.ts'
export {
  ConsensusCoordinator,
  type ConsensusCoordinatorOptions,
  type ConsensusAgentSetup,
} from './consensus/orchestrator.ts'
export {
  createProtocolOutputTool,
  PROTOCOL_OUTPUT_TOOL_NAME,
  type ProtocolToolSpec,
} from './consensus/protocol-tool.ts'
export {
  createTaskScratch,
  cleanupConversationScratch,
  type TaskScratch,
} from './consensus/scratch.ts'
export type {
  ConsensusAgentId,
  ProtocolMode,
  VoteValue,
  Vote,
  Candidate,
  CandidateContent,
  ProtocolOutput,
  AgentMemorySummary,
  ConsensusPersistedState,
  ConsensusTaskOutcome,
} from './consensus/types.ts'
export { consensusPersistedStateSchema } from './consensus/types.ts'
export { SessionStore, SessionJournal } from './session/store.ts'
export { releaseShadowRefs } from './checkpoints/manager.ts'
export {
  pushCoalescedViewEvent,
  toViewEvent,
  viewEventSchema,
  visibleCoreEventSchema,
} from './session/view-events.ts'
export type { ViewEvent, VisibleCoreEvent } from './session/view-events.ts'
export type {
  LoadedSession,
  SessionCreateInput,
  SessionMetadata,
  SessionRecorder,
} from './session/types.ts'
export {
  activeTaskPlanSchema,
  taskItemSchema,
  taskItemStatusSchema,
  taskPlanSchema,
} from './tasks/types.ts'
export type {
  ActiveTaskPlan,
  TaskItem,
  TaskItemStatus,
  TaskPlan,
} from './tasks/types.ts'
