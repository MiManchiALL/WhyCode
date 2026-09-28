/**
 * Renderer ↔ Main 的 IPC 通道常量。M1 采用手写 channel 常量方案（决策记录见文档二 §7）。
 * 命令走 invoke/handle，高频运行事件走长期 MessagePort，其余低频状态走 send。
 */
export const IPC = {
  ssh: 'whycode:ssh',
  sshChanged: 'whycode:ssh-changed',
  /** 窗口关闭前的草稿落盘握手，仅传递 ready/flush/saved/failed/unready 状态。 */
  composerPersistence: 'whycode:composer-persistence',
  /** Renderer → Main：发送 CoreCommand */
  command: 'whycode:command',
  /** Preload → Main：为当前主页面申请一条长期 CoreEvent 流端口。 */
  runtimeEventPortRequest: 'whycode:runtime-event-port-request',
  /** Main → Preload：只用于转交原生 MessagePort，不承载业务事件。 */
  runtimeEventPort: 'whycode:runtime-event-port',
  /** Main → Renderer：当前进程内后台任务整表快照。 */
  backgroundTasks: 'whycode:background-tasks',
  /** Main → Renderer：当前父会话的子代理有界摘要。 */
  subagents: 'whycode:subagents',
  /** Main → Renderer：子代理独立 transcript 的实时事件。 */
  subagentEvent: 'whycode:subagent-event',
  /** Renderer → Main：按父会话所有权读取一个子代理的只读 transcript。 */
  subagentTranscript: 'whycode:subagent-transcript',
  checkpointFileChanges: 'whycode:checkpoint-file-changes',
  /** Renderer → Main：按当前会话检查点读取一个文件工具的前后版本。 */
  checkpointFilePreview: 'whycode:checkpoint-file-preview',
  /** Renderer → Main：判断一个操作后快照是否等于当前路径状态。 */
  checkpointFileCurrentMatch: 'whycode:checkpoint-file-current-match',
  /** 只读文件视图与预览地址随可见标签页释放，不进入 Agent 上下文。 */
  openWorkspaceFile: 'whycode:open-workspace-file',
  readWorkspaceFile: 'whycode:read-workspace-file',
  closeWorkspaceFile: 'whycode:close-workspace-file',
  revealWorkspaceFile: 'whycode:reveal-workspace-file',
  openWorkspaceFileExternally: 'whycode:open-workspace-file-externally',
  workspaceFileChanged: 'whycode:workspace-file-changed',
  /** 用户终端独立于 Agent 命令；输出不进入会话事实源。 */
  createTerminal: 'whycode:create-terminal',
  closeTerminal: 'whycode:close-terminal',
  terminalControl: 'whycode:terminal-control',
  terminalEvent: 'whycode:terminal-event',
  terminalClosed: 'whycode:terminal-closed',
  /** Renderer → Main：获取可用模型列表 */
  listModels: 'whycode:list-models',
  /** Renderer → Main：按当前运行目录与模型预算取得本轮 Skill 目录。 */
  listSkills: 'whycode:list-skills',
  /** Renderer → Main：模型、CLIProxyAPI、网页搜索与 MCP 连接设置。 */
  connectionSettings: 'whycode:connection-settings',
  mcpStatus: 'whycode:mcp-status',
  saveProviderSettings: 'whycode:save-provider-settings',
  saveCliProxyApiSettings: 'whycode:save-cliproxyapi-settings',
  saveAuxiliaryModelSettings: 'whycode:save-auxiliary-model-settings',
  saveConsensusModelSettings: 'whycode:save-consensus-model-settings',
  saveWebSearchSettings: 'whycode:save-web-search-settings',
  setMcpServerEnabled: 'whycode:set-mcp-server-enabled',
  addMcpServer: 'whycode:add-mcp-server',
  saveMcpSecretHeader: 'whycode:save-mcp-secret-header',
  authorizeMcpOAuth: 'whycode:authorize-mcp-oauth',
  disconnectMcpOAuth: 'whycode:disconnect-mcp-oauth',
  openMcpConfig: 'whycode:open-mcp-config',
  /** Renderer → Main：弹目录选择框，返回选中的项目目录（取消返回 null） */
  pickProjectDir: 'whycode:pick-project-dir',
  inspectDraftWorkspace: 'whycode:inspect-draft-workspace',
  worktreeStatus: 'whycode:worktree-status',
  createWorktreeBranch: 'whycode:create-worktree-branch',
  openWorkspaceFolder: 'whycode:open-workspace-folder',
  discardWorktree: 'whycode:discard-worktree',
  /** Renderer 重载/崩溃恢复：重新取得当前会话、稳定时间线与主进程运行态。 */
  runtimeSnapshot: 'whycode:runtime-snapshot',
  conversationHistory: 'whycode:conversation-history',
  /** Renderer → Main：查询协商可用状态（M3） */
  consensusStatus: 'whycode:consensus-status',
  /** Renderer → Main：会话列表与生命周期（M4） */
  listSessionSidebar: 'whycode:list-session-sidebar',
  renameProject: 'whycode:rename-project',
  removeProject: 'whycode:remove-project',
  /** Main → Renderer：异步会话物理清理终态。 */
  sessionDeletion: 'whycode:session-deletion',
  resumeSession: 'whycode:resume-session',
  forkSession: 'whycode:fork-session',
  newSession: 'whycode:new-session',
  setSessionPinned: 'whycode:set-session-pinned',
  renameSession: 'whycode:rename-session',
  deleteSession: 'whycode:delete-session',
  previewSessionDeletion: 'whycode:preview-session-deletion',
  listRetainedWorkspaces: 'whycode:list-retained-workspaces',
  previewRetainedWorkspace: 'whycode:preview-retained-workspace',
  openRetainedWorkspace: 'whycode:open-retained-workspace',
  renameRetainedWorkspace: 'whycode:rename-retained-workspace',
  deleteRetainedWorkspace: 'whycode:delete-retained-workspace',
  /** Renderer → Main：按当前会话内的 PDF 附件 ID 交给系统默认阅读器打开。 */
  openPdfAttachment: 'whycode:open-pdf-attachment',
} as const
