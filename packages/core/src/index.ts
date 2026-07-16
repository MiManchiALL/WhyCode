export type {
  CoreEvent,
  CoreCommand,
  CoreEventSink,
  UsageInfo,
  AgentStatus,
  QueuedUserMessage,
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
  BUILTIN_PROVIDERS,
  MODEL_CATALOG,
  getBuiltInProvider,
  getModelProfile,
  matchModelProfile,
  normalizeModelIdentity,
  type BuiltInProviderId,
  type BuiltInProviderProfile,
  type ModelProfile,
  type ModelProfileMatch,
  type ModelProviderId,
} from './providers/catalog.ts'
export {
  CUSTOM_API_PROTOCOLS,
  createCustomModelEntry,
  type CapabilityProbeState,
  type CustomApiProtocolDescriptor,
  type CustomApiProtocol,
  type CustomConnectionProbe,
  type CustomModelEntryOptions,
} from './providers/custom.ts'
export {
  compactProbeReport,
  probeCustomConnection,
  type CapabilityProbeOutcome,
  type CustomConnectionProbeOptions,
  type CustomConnectionProbeReport,
} from './providers/probe.ts'
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
  createReadPdfTool,
  READ_PDF_TOOL_NAME,
  type ReadPdfToolOptions,
  type ResolvedPdfAttachment,
} from './tools/read-pdf/index.ts'
export {
  CommandSessionManager,
  createBackgroundCommandTools,
  START_COMMAND_TOOL_NAME,
  LIST_COMMANDS_TOOL_NAME,
  GET_COMMAND_OUTPUT_TOOL_NAME,
  WRITE_COMMAND_INPUT_TOOL_NAME,
  STOP_COMMAND_TOOL_NAME,
  type CommandOutputChunk,
  type CommandTaskSnapshot,
  type CommandTaskStatus,
} from './tools/background-command/index.ts'
export {
  CAPTURE_SCREENSHOT_TOOL_NAME,
  createCaptureScreenshotTool,
  screenshotCaptureRequestSchema,
  type ScreenshotCaptureHandler,
  type ScreenshotCaptureRequest,
  type ScreenshotCaptureResult,
} from './tools/capture-screenshot/index.ts'
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
export { validateSessionId } from './session/metadata.ts'
export {
  IMAGE_ATTACHMENT_MAX_COUNT,
  IMAGE_ATTACHMENT_MAX_DIMENSION,
  IMAGE_ATTACHMENT_MAX_PIXELS,
  IMAGE_ATTACHMENT_MAX_SOURCE_BYTES,
  IMAGE_MODEL_MAX_BYTES,
  IMAGE_MODEL_MAX_DIMENSION,
  createImageAttachmentsSchema,
  imageAttachmentSchema,
  imageAttachmentsSchema,
  imageAttachmentStorageNameSchema,
  imageAttachmentSourceSchema,
  imageDetailSchema,
  imageRegionSchema,
  imageTransformSchema,
  type ImageAttachment,
  type ImageAttachmentSource,
  type ImageDetail,
  type ImageAttachmentInput,
  type ImageMessageAttachmentInput,
  type ImageMediaType,
  type ImageRegion,
  type ImageTransform,
} from './attachments/types.ts'
export {
  cleanupUnreferencedImageAttachments,
  importImageAttachments,
  prepareImageAttachmentImport,
  readStoredImage,
  validateStoredImageAttachments,
} from './attachments/storage.ts'
export type { ImageAttachmentImportTransaction } from './attachments/storage.ts'
export {
  cleanupUnreferencedAttachments,
  type SessionAttachmentReferences,
} from './attachments/cleanup.ts'
export {
  PDF_ATTACHMENT_MAX_COUNT,
  PDF_ATTACHMENT_MAX_PAGES,
  PDF_ATTACHMENT_MAX_SOURCE_BYTES,
  PDF_ATTACHMENT_MAX_TOTAL_BYTES,
  PDF_INLINE_VISUAL_MAX_BYTES,
  PDF_INLINE_VISUAL_MAX_PAGES,
  PDF_TEXT_DEFAULT_PAGES,
  PDF_TEXT_MAX_CHARS,
  PDF_TEXT_MAX_PAGES,
  PDF_VISUAL_MAX_PAGES,
  pdfAttachmentSchema,
  pdfAttachmentsSchema,
  pdfAttachmentStorageNameSchema,
  type PdfAttachment,
  type PdfAttachmentInput,
  type PdfMessageAttachmentInput,
} from './pdf/types.ts'
export { inlineSmallPdfMessages } from './pdf/inline-messages.ts'
export {
  PdfProcessingError,
  type PdfDocumentInfo,
  type PdfPageReadOptions,
  type PdfPageReadResult,
  type PdfPageText,
  type PdfProcessingErrorCode,
  type PdfProcessor,
  type PdfRenderedPage,
} from './pdf/processor.ts'
export {
  pdfAttachmentPath,
  preparePdfAttachmentImport,
  validateStoredPdfAttachments,
  type PdfAttachmentImportTransaction,
} from './pdf/storage.ts'
export {
  compactPdfAttachmentContext,
  pdfAttachmentReferenceBlock,
  referencedPdfAttachmentIds,
  withPdfAttachmentReferences,
} from './pdf/messages.ts'
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
  SessionSummary,
} from './session/types.ts'
export {
  activeTaskPlanSchema,
  supersededTaskPlanSchema,
  taskPlanStateSchema,
  historicalTaskPlanSummarySchema,
  taskItemSchema,
  taskItemStatusSchema,
  taskPlanSchema,
} from './tasks/types.ts'
export type {
  ActiveTaskPlan,
  HistoricalTaskPlanSummary,
  SupersededTaskPlan,
  TaskItem,
  TaskItemStatus,
  TaskPlan,
  TaskPlanState,
} from './tasks/types.ts'
