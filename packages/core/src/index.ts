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
} from './consensus/types.ts'
