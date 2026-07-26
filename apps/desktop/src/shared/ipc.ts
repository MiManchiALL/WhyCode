/**
 * Renderer ↔ Main 的 IPC 通道常量。M1 采用手写 channel 常量方案（决策记录见文档二 §7）。
 * 命令走 invoke/handle，事件流走 Main → Renderer 单向 send。
 */
export const IPC = {
  /** Renderer → Main：发送 CoreCommand */
  command: 'whycode:command',
  /** Main → Renderer：CoreEvent 事件流 */
  event: 'whycode:event',
  /** Renderer → Main：获取可用模型列表 */
  listModels: 'whycode:list-models',
  /** Renderer → Main：模型、CLIProxyAPI、网页搜索与 MCP 连接设置。 */
  connectionSettings: 'whycode:connection-settings',
  saveProviderSettings: 'whycode:save-provider-settings',
  saveCliProxyApiSettings: 'whycode:save-cliproxyapi-settings',
  saveWebSearchSettings: 'whycode:save-web-search-settings',
  setMcpServerEnabled: 'whycode:set-mcp-server-enabled',
  enableMcpPreset: 'whycode:enable-mcp-preset',
  addMcpServer: 'whycode:add-mcp-server',
  saveMcpSecretHeader: 'whycode:save-mcp-secret-header',
  openMcpConfig: 'whycode:open-mcp-config',
  /** Renderer → Main：弹目录选择框，返回选中的项目目录（取消返回 null） */
  pickProjectDir: 'whycode:pick-project-dir',
  /** Renderer → Main：查询当前项目目录 */
  getProjectDir: 'whycode:get-project-dir',
  /** Renderer 重载/崩溃恢复：重新取得当前会话、稳定时间线与主进程运行态。 */
  runtimeSnapshot: 'whycode:runtime-snapshot',
  /** Renderer → Main：查询协商可用状态（M3） */
  consensusStatus: 'whycode:consensus-status',
  /** Renderer → Main：会话列表与生命周期（M4） */
  listSessions: 'whycode:list-sessions',
  resumeSession: 'whycode:resume-session',
  newSession: 'whycode:new-session',
  deleteSession: 'whycode:delete-session',
  /** Renderer → Main：按当前会话内的 PDF 附件 ID 交给系统默认阅读器打开。 */
  openPdfAttachment: 'whycode:open-pdf-attachment',
} as const
