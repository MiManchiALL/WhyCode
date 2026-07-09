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
  /** Renderer → Main：弹目录选择框，返回选中的项目目录（取消返回 null） */
  pickProjectDir: 'whycode:pick-project-dir',
  /** Renderer → Main：查询当前项目目录 */
  getProjectDir: 'whycode:get-project-dir',
  /** Renderer → Main：查询协商可用状态（M3） */
  consensusStatus: 'whycode:consensus-status',
  /** Renderer → Main：会话列表与生命周期（M4） */
  listSessions: 'whycode:list-sessions',
  resumeSession: 'whycode:resume-session',
  newSession: 'whycode:new-session',
  deleteSession: 'whycode:delete-session',
} as const
