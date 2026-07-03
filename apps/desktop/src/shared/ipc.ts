/**
 * Renderer ↔ Main 的 IPC 通道常量。M1 采用手写 channel 常量方案（决策记录见文档二 §7）。
 * 命令走 invoke/handle，事件流走 Main → Renderer 单向 send。
 */
export const IPC = {
  /** Renderer → Main：发送 CoreCommand */
  command: 'whycode:command',
  /** Main → Renderer：CoreEvent 事件流 */
  event: 'whycode:event',
} as const
